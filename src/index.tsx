import type { CacheStorage } from "@cloudflare/workers-types";

declare const caches: CacheStorage;

import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { prettyJSON } from "hono/pretty-json";
import { OpenAI } from "openai";
import {
	checkRateLimit,
	DAILY_API_LIMIT,
	getDailyUsage,
	RATE_LIMIT_MAX,
	RATE_LIMIT_WINDOW,
} from "./rateLimit";
import { renderer } from "./renderer";
import type { ApiSuccess, Bindings } from "./types";
import { processInput, SYSTEM_PROMPT, validateApiResponse } from "./utils";

/**
 * Common security headers for API responses and endpoints.
 * Helps prevent XSS, clickjacking, and other web vulnerabilities.
 * Used for all API and HTML responses to enforce strict security policies.
 *
 * @property {string} Content-Type - Specifies the media type of the resource.
 * @property {string} X-Content-Type-Options - Prevents MIME type sniffing.
 * @property {string} X-Frame-Options - Prevents the page from being displayed in a frame.
 * @property {string} Strict-Transport-Security - Enforces secure (HTTPS) connections to the server.
 * @property {string} Referrer-Policy - Controls how much referrer information is included with requests.
 * @property {string} Content-Security-Policy - Restricts sources for content, frames, and base URI.
 */
const securityHeaders = {
	"Content-Type": "application/json",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy":
		"default-src 'none'; frame-ancestors 'none'; base-uri 'none';",
};

/**
 * OpenAPI document for Swagger UI integration.
 * Describes all public endpoints for Kronilo Worker.
 * Used by /doc and /ui endpoints for API documentation and interactive testing.
 */
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
				responses: {
					"200": { description: "HTML page" },
				},
			},
		},
		"/health": {
			get: {
				summary: "Health check",
				responses: {
					"200": { description: "OK" },
				},
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
								properties: {
									input: { type: "string" },
									language: {
										type: "string",
										description:
											"ISO language code (e.g. 'en', 'fr', 'de', 'es'). Optional, defaults to 'en'.",
									},
								},
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
										language: {
											type: "string",
											description: "ISO language code used for translation.",
										},
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

/**
 * Main Hono application instance for the Kronilo cron translation service.
 * Configured with Cloudflare Workers bindings for KV storage and environment variables.
 */
const app = new Hono<{ Bindings: Bindings }>();

/**
 * Serves the OpenAPI document for Swagger UI and other tools.
 * Endpoint: GET /doc
 * Returns: OpenAPI JSON spec for all public endpoints.
 *
 * Useful for API clients, code generation, and documentation tools.
 */
app.get("/doc", (c) => c.json(openApiDoc));

/**
 * Serves Swagger UI for interactive API documentation and testing.
 * Endpoint: GET /ui
 * Returns: Swagger UI HTML page.
 *
 * Useful for developers and testers to try endpoints live.
 */
app.get("/ui", swaggerUI({ url: "/doc" }));

/**
 * Metrics and observability object for API requests.
 * Tracks timing, cache usage, model selection, error states, rate limiting, and timeouts.
 * Used for logging and debugging API behavior and performance.
 */
// See usage in /api/translate endpoint below.

/**
 * Configure CORS middleware to allow requests from approved origins.
 * Permits access from production domains and local development.
 *
 * If you add new frontend domains, update the origin list below.
 */
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

/**
 * Request logging middleware that captures method, URL, and client IP.
 * Logs all incoming requests with timestamp for monitoring and debugging.
 *
 * For privacy, IPs are not stored, only logged to console.
 */
app.use(async (c, next) => {
	const { method, url } = c.req;
	const ip =
		c.req.header("CF-Connecting-IP") ||
		c.req.header("x-forwarded-for") ||
		"unknown";
	console.log(`[${new Date().toISOString()}] ${method} ${url} from IP: ${ip}`);
	await next();
});

/**
 * Root endpoint that returns a simple HTML page identifying the service.
 * Endpoint: GET /
 * Returns: HTML page with service name.
 *
 * Used for browser access and uptime checks.
 */
app.get("/", (c) => {
	return c.render(<h1>Kronilo - Cron Expression Translator</h1>);
});

/**
 * Health check endpoint that provides service status and rate limit information.
 * Endpoint: GET /health
 * Returns: JSON with current rate limiting stats including per-user and daily usage data.
 *
 * Useful for monitoring and alerting integrations.
 */
app.get("/health", async (c) => {
	if (!c.env.RATE_LIMIT_KV) {
		return c.json(
			{
				status: "error",
				error: "Missing RATE_LIMIT_KV binding in environment",
			},
			500,
		);
	}
	const dailyUsage = await getDailyUsage(c.env.RATE_LIMIT_KV);
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

/**
 * Cache version identifier for API responses.
 * Increment this when cache invalidation is needed due to logic changes.
 *
 * Used for cache busting in Cloudflare cache.
 */
const CACHE_VERSION = "v4";

/**
 * Primary AI model for cron expression translation via OpenRouter.
 *
 * Change this to update the default model used for translation.
 */
const PRIMARY_MODEL = "google/gemini-2.0-flash-exp:free";

/**
 * Backup AI model used when the primary model fails or is unavailable.
 *
 * Used for fallback and reliability.
 */
const BACKUP_MODEL = "mistralai/mistral-7b-instruct:free";

/**
 * Main API endpoint for translating plain English input to cron expressions.
 * Endpoint: POST /api/translate
 * Request body: { input: string, language?: string }
 *   - input: The plain English description to translate (required)
 *   - language: ISO language code (e.g. 'en', 'fr', 'de', 'es'). Optional, defaults to 'en'.
 * Returns: JSON response with cron expression or error details.
 * Response body: { cron: string, model: string, input: string, language: string }
 * Features:
 *   - Rate limiting (per-user and daily limits)
 *   - Response caching for identical inputs
 *   - Retry logic with primary and backup AI models
 *   - Input validation and sanitization
 *   - Comprehensive error handling
 *
 * If you change the request/response format, update openApiDoc above.
 */
app.post("/api/translate", async (c) => {
	try {
		/**
		 * Metrics object for this request.
		 * @property start - Timestamp when request started
		 * @property cacheHit - True if response was served from cache
		 * @property model - Model used for translation (primary or backup)
		 * @property attempts - Number of model attempts
		 * @property error - Error message if any
		 * @property rateLimit - True if request was rate limited
		 * @property timeout - True if model call timed out
		 */
		const metrics: {
			start: number;
			cacheHit: boolean;
			model: string | null;
			attempts: number;
			error: string | null;
			rateLimit: boolean;
			timeout: boolean;
		} = {
			start: Date.now(),
			cacheHit: false,
			model: null,
			attempts: 0,
			error: null,
			rateLimit: false,
			timeout: false,
		};

		const OPENROUTER_API_KEY = c.env.OPENROUTER_API_KEY;
		/**
		 * Error handling: Missing OpenRouter API key.
		 * Logs error and returns 500 response with error message.
		 */
		if (!OPENROUTER_API_KEY) {
			metrics.error = "Missing OPENROUTER_API_KEY";
			console.error("[metrics]", metrics);
			return c.text(
				JSON.stringify({
					error: "Missing OPENROUTER_API_KEY environment variable",
				}),
				500,
				securityHeaders,
			);
		}

		const { input = "", language = "en" } = await c.req.json<{
			input?: string;
			language?: string;
		}>();
		let trimmedInput = processInput(input);
		trimmedInput = trimmedInput
			.replace(/[<>"'`]/g, "")
			.replace(/\s+/g, " ")
			.trim();
		const trimmedLanguage = (
			typeof language === "string" ? language.trim().toLowerCase() : "en"
		).slice(0, 8);
		if (trimmedInput.length > 200) {
			metrics.error = "Input too long";
			console.error("[metrics]", metrics);
			return c.text(
				JSON.stringify({ error: "Input too long (max 200 characters)" }),
				413,
				securityHeaders,
			);
		}
		if (!trimmedInput) {
			metrics.error = "Missing input field";
			console.error("[metrics]", metrics);
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
		if (!(await checkRateLimit(ip, c.env.RATE_LIMIT_KV))) {
			metrics.rateLimit = true;
			const dailyUsage = await getDailyUsage(c.env.RATE_LIMIT_KV);
			const isDailyLimit = dailyUsage.remaining <= 0;
			const errorMessage = isDailyLimit
				? "Daily API limit reached. Please try again tomorrow."
				: "Rate limit exceeded. Please try again later.";
			console.warn(
				`[RateLimit] IP: ${ip}, Type: ${isDailyLimit ? "daily" : "perUser"}, Usage:`,
				dailyUsage,
			);
			metrics.error = errorMessage;
			console.error("[metrics]", metrics);
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
		let cached: unknown;
		try {
			cached = await cache.match(cacheKey);
		} catch (cacheErr) {
			console.error("[CacheError]", cacheErr);
		}
		if (cached) {
			metrics.cacheHit = true;
			try {
				const cachedData = await (cached as Response).json();
				metrics.model = cachedData.model || null;
				metrics.attempts = 0;
				console.info("[metrics]", metrics);
				return c.text(JSON.stringify(cachedData), 200, securityHeaders);
			} catch (cacheParseErr) {
				console.error("[CacheParseError]", cacheParseErr);
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

		/**
		 * Makes an API call to the specified AI model for cron translation.
		 * Handles timeout errors and validates response format.
		 * @param model - The AI model identifier to use
		 * @param attempt - The attempt number (affects temperature setting)
		 * @returns Promise resolving to a successful API response
		 * @throws Error if the model returns an invalid response or times out
		 */
		let timeoutError = false;
		const makeApiCall = async (
			model: string,
			attempt: number,
		): Promise<ApiSuccess> => {
			try {
				// Pass language code as part of the user message for LLM context
				const userPrompt = `Language: ${trimmedLanguage}\n${trimmedInput}`;
				const response = await openai.chat.completions.create(
					{
						model,
						messages: [
							{ role: "system", content: SYSTEM_PROMPT },
							{ role: "user", content: userPrompt },
						],
						max_tokens: 50,
						temperature: attempt > 1 ? 0.1 : 0,
					},
					{
						timeout: 5_000,
					},
				);
				const output = response.choices?.[0]?.message?.content?.trim() ?? "";
				const validation = validateApiResponse(output);
				if (!validation.isValid) {
					throw new Error(validation.error || "Invalid response format");
				}
				return {
					cron: output,
					model,
					input: trimmedInput,
					language: trimmedLanguage,
				};
			} catch (err) {
				if (
					typeof err === "object" &&
					err !== null &&
					"message" in err &&
					typeof (err as { message?: string }).message === "string" &&
					(err as { message?: string }).message?.includes("timeout")
				) {
					timeoutError = true;
				}
				throw err;
			}
		};

		let result: ApiSuccess | null = null;
		let lastError: unknown = null;
		let usedModel: string | null = null;
		let attempts = 0;

		attempts++;
		try {
			result = await makeApiCall(PRIMARY_MODEL, 1);
			usedModel = PRIMARY_MODEL;
		} catch (err) {
			lastError = err;
			console.error(`Primary model ${PRIMARY_MODEL} attempt 1 failed:`, err);
		}

		if (!result) {
			attempts++;
			try {
				result = await makeApiCall(BACKUP_MODEL, 1);
				usedModel = BACKUP_MODEL;
			} catch (err) {
				lastError = err;
				console.error(`Backup model ${BACKUP_MODEL} attempt 1 failed:`, err);
			}
		}

		metrics.model = usedModel;
		metrics.attempts = attempts;
		metrics.timeout = timeoutError;

		/**
		 * Error handling: Model translation failed after all attempts.
		 * Logs error and returns 400 response with details.
		 */
		if (!result) {
			metrics.error = "Model translation failed";
			console.error("[metrics]", metrics);
			return c.text(
				JSON.stringify({
					error:
						"Could not translate input to a valid cron expression after retrying",
					details: {
						input: trimmedInput,
						model: usedModel,
						attempts,
						lastError: lastError,
					},
				}),
				400,
				securityHeaders,
			);
		}

		/**
		 * Attempts to cache the successful response.
		 * Logs cache put errors but does not block response.
		 */
		try {
			await cache.put(
				cacheKey,
				new Response(JSON.stringify(result), {
					headers: {
						...securityHeaders,
						"Cache-Control": "max-age=1814400",
					},
				}),
			);
		} catch (cachePutErr) {
			console.error("[CachePutError]", cachePutErr);
		}

		/**
		 * Logs metrics and returns successful response.
		 */
		console.info("[metrics]", metrics);
		return c.text(JSON.stringify(result), 200, securityHeaders);
	} catch (err) {
		/**
		 * Error handling: Unexpected internal server error.
		 * Logs error and returns 500 response with details.
		 */
		console.error("Error in /api/translate:", err);
		console.error("[metrics]", { error: err });
		return c.text(
			JSON.stringify({ error: "Internal server error", details: err }),
			500,
			securityHeaders,
		);
	}
});

export default app;
