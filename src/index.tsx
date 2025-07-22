import type { CacheStorage } from "@cloudflare/workers-types";

declare const caches: CacheStorage;

import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { prettyJSON } from "hono/pretty-json";
import { OpenAI } from "openai";
import type {
	ApiSuccess,
	Bindings,
	Metrics,
	TranslateRequestBody,
} from "./interfaces";
import {
	checkRateLimit,
	DAILY_API_LIMIT,
	getDailyUsage,
	RATE_LIMIT_MAX,
	RATE_LIMIT_WINDOW,
} from "./rateLimit";
import { renderer } from "./renderer";
import { SYSTEM_PROMPT } from "./systemPrompt";
import {
	logError,
	logInfo,
	logWarn,
	processInput,
	validateApiResponse,
} from "./utils";

const securityHeaders = {
	"Content-Type": "application/json",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy":
		"default-src 'none'; frame-ancestors 'none'; base-uri 'none';",
};

const openApiDoc = {
	openapi: "3.0.0",
	info: {
		title: "Kronilo API Documentation",
		version: "1.0.0",
		description: "API documentation for Kronilo endpoints",
	},
	paths: {
		"/": {
			get: {
				summary: "Root endpoint",
				responses: { "200": { description: "HTML page" } },
			},
		},
		"/health": {
			get: {
				summary: "Health check",
				responses: { "200": { description: "OK" } },
			},
		},
		"/api/translate": {
			post: {
				summary: "Translate plain English to cron expression",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: { input: { type: "string" } },
								required: ["input"],
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Translation result",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										cron: { type: "string" },
										model: { type: "string" },
										input: { type: "string" },
									},
								},
							},
						},
					},
					"400": { description: "Bad request" },
					"429": { description: "Rate limited" },
					"500": { description: "Internal error" },
				},
			},
		},
	},
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/doc", (c) => c.json(openApiDoc));
app.get("/ui", swaggerUI({ url: "/doc" }));

app.use(
	"/*",
	cors({
		origin: [
			"https://kronilo.timothybrits.com",
			"https://kronilo.onrender.com",
			"http://localhost:5173",
		],
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type"],
	}),
);

app.use(renderer);
app.use(prettyJSON());

app.use(async (c, next) => {
	const { method, url } = c.req;
	const ip =
		c.req.header("CF-Connecting-IP") ||
		c.req.header("x-forwarded-for") ||
		"unknown";
	logInfo(
		"Request",
		`[${new Date().toISOString()}] ${method} ${url} from IP: ${ip}`,
	);
	await next();
});

app.get("/", (c) => c.render(<h1>Kronilo - Cron Expression Translator</h1>));

app.get("/health", async (c) => {
	const env = c.env as Bindings;
	if (!env.RATE_LIMIT_KV) {
		return c.json(
			{
				status: "error",
				error: "Missing RATE_LIMIT_KV binding in environment",
			},
			500,
		);
	}
	const dailyUsage = await getDailyUsage(env.RATE_LIMIT_KV);
	return c.json({
		status: "ok",
		rateLimit: {
			perUser: {
				max: RATE_LIMIT_MAX,
				windowMs: RATE_LIMIT_WINDOW,
			},
			daily: {
				limit: DAILY_API_LIMIT,
				used: dailyUsage.count,
				remaining: dailyUsage.remaining,
				date: dailyUsage.date,
			},
		},
	});
});

const CACHE_VERSION = "v5";
const PRIMARY_MODEL = "google/gemini-2.0-flash-exp:free";
const BACKUP_MODEL = "mistralai/mistral-7b-instruct:free";

app.post("/api/translate", async (c) => {
	const env = c.env as Bindings;
	const metrics: Metrics = {
		start: Date.now(),
		cacheHit: false,
		model: null,
		attempts: 0,
		error: null,
		rateLimit: false,
		timeout: false,
	};

	try {
		const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
		if (!OPENROUTER_API_KEY) {
			metrics.error = "Missing OPENROUTER_API_KEY";
			logError("metrics", metrics);
			return c.text(
				JSON.stringify({
					error: "Missing OPENROUTER_API_KEY environment variable",
				}),
				500,
				securityHeaders,
			);
		}

		const { input = "" } = await c.req.json<TranslateRequestBody>();
		const trimmedInput = processInput(input)
			.replace(/[<>"'`]/g, "")
			.replace(/\s+/g, " ")
			.trim();

		if (trimmedInput.length > 200) {
			metrics.error = "Input too long";
			logError("metrics", metrics);
			return c.text(
				JSON.stringify({ error: "Input too long (max 200 characters)" }),
				413,
				securityHeaders,
			);
		}
		if (!trimmedInput) {
			metrics.error = "Missing input field";
			logError("metrics", metrics);
			return c.text(
				JSON.stringify({ error: "Missing input field" }),
				400,
				securityHeaders,
			);
		}

		const ip =
			c.req.header("CF-Connecting-IP") ||
			c.req.header("x-forwarded-for") ||
			"unknown";
		if (!(await checkRateLimit(ip, env.RATE_LIMIT_KV))) {
			metrics.rateLimit = true;
			const dailyUsage = await getDailyUsage(env.RATE_LIMIT_KV);
			const isDailyLimit = dailyUsage.remaining <= 0;
			const errorMessage = isDailyLimit
				? "Daily API limit reached. Please try again tomorrow."
				: "Rate limit exceeded. Please try again later.";
			logWarn(
				"RateLimit",
				`IP: ${ip}, Type: ${isDailyLimit ? "daily" : "perUser"}, Usage: ${JSON.stringify(dailyUsage)}`,
			);
			metrics.error = errorMessage;
			logError("metrics", metrics);
			return c.text(
				JSON.stringify({
					error: errorMessage,
					rateLimitType: isDailyLimit ? "daily" : "perUser",
					details: {
						daily: dailyUsage,
						perUser: {
							maxPerHour: RATE_LIMIT_MAX,
							windowMs: RATE_LIMIT_WINDOW,
						},
					},
				}),
				429,
				securityHeaders,
			);
		}

		const cacheKey = new Request(
			`https://cache.kronilo/translate?version=${CACHE_VERSION}&input=${encodeURIComponent(trimmedInput)}`,
		);
		const cache = (caches as unknown as { default: Cache }).default;

		let cached: Response | undefined;
		try {
			cached = await cache.match(cacheKey);
		} catch (cacheErr) {
			logError("CacheError", cacheErr);
		}

		if (cached) {
			metrics.cacheHit = true;
			try {
				// Explicitly typed
				const cachedData = (await cached.json()) as ApiSuccess;
				metrics.model = cachedData.model || null;
				metrics.attempts = 0;
				logInfo("metrics", metrics);
				return c.text(JSON.stringify(cachedData), 200, securityHeaders);
			} catch (cacheParseErr) {
				logError("CacheParseError", cacheParseErr);
			}
		}

		const openai = new OpenAI({
			apiKey: OPENROUTER_API_KEY,
			baseURL: "https://openrouter.ai/api/v1",
			defaultHeaders: {
				"HTTP-Referer":
					c.req.header("origin") || "https://kronilo.timothybrits.com",
				"X-Title": "Kronilo",
			},
		});

		let timeoutError = false;

		const makeApiCall = async (
			model: string,
			attempt: number,
		): Promise<ApiSuccess> => {
			try {
				const response = await openai.chat.completions.create(
					{
						model,
						messages: [
							{ role: "system", content: SYSTEM_PROMPT },
							{ role: "user", content: trimmedInput },
						],
						max_tokens: 50,
						temperature: attempt > 1 ? 0.1 : 0,
					},
					{ timeout: 5_000 },
				);
				const output = response.choices?.[0]?.message?.content?.trim() ?? "";
				const validation = validateApiResponse(output);
				if (!validation.isValid)
					throw new Error(validation.error || "Invalid response format");
				return { cron: output, model, input: trimmedInput };
			} catch (err: unknown) {
				if (err instanceof Error && err.message.includes("timeout")) {
					timeoutError = true;
				}
				throw err;
			}
		};

		let result: ApiSuccess | null = null;
		let lastError: unknown = null;
		let usedModel: string | null = null;
		let attempts = 0;

		const delay = (ms: number) =>
			new Promise((resolve) => setTimeout(resolve, ms));

		for (let i = 1; i <= 2; i++) {
			attempts++;
			try {
				result = await makeApiCall(PRIMARY_MODEL, i);
				usedModel = PRIMARY_MODEL;
				break;
			} catch (err: unknown) {
				lastError = err;
				if (!(timeoutError && i < 2)) {
					if (err instanceof Error) {
						logError(`Primary model ${PRIMARY_MODEL} attempt ${i} failed`, err);
					} else {
						logError(
							`Primary model ${PRIMARY_MODEL} attempt ${i} failed with unknown error`,
							err,
						);
					}
					break;
				}
				logWarn(
					`Primary model ${PRIMARY_MODEL} timed out`,
					`Retrying (attempt ${i + 1})...`,
				);
				await delay(250);
			}
		}

		if (!result) {
			attempts++;
			try {
				result = await makeApiCall(BACKUP_MODEL, 1);
				usedModel = BACKUP_MODEL;
			} catch (err: unknown) {
				lastError = err;
				if (err instanceof Error) {
					logError(`Backup model ${BACKUP_MODEL} attempt 1 failed`, err);
				} else {
					logError(
						`Backup model ${BACKUP_MODEL} attempt 1 failed with unknown error`,
						err,
					);
				}
			}
		}

		metrics.model = usedModel;
		metrics.attempts = attempts;
		metrics.timeout = timeoutError;

		if (!result) {
			metrics.error = "Model translation failed";
			logError("metrics", metrics);
			return c.text(
				JSON.stringify({
					error:
						"Could not translate input to a valid cron expression after retrying",
					details: {
						input: trimmedInput,
						model: usedModel,
						attempts,
						lastError,
					},
				}),
				400,
				securityHeaders,
			);
		}

		try {
			await cache.put(
				cacheKey,
				new Response(JSON.stringify(result), {
					headers: { ...securityHeaders, "Cache-Control": "max-age=1814400" },
				}),
			);
		} catch (cachePutErr) {
			logError("CachePutError", cachePutErr);
		}

		logInfo("metrics", metrics);
		return c.text(JSON.stringify(result), 200, securityHeaders);
	} catch (err: unknown) {
		if (err instanceof Error) {
			logError("Error in /api/translate", err);
		} else {
			logError("Unknown error in /api/translate", err);
		}
		logError("metrics", { error: err });
		return c.text(
			JSON.stringify({ error: "Internal server error", details: err }),
			500,
			securityHeaders,
		);
	}
});

export default app;
