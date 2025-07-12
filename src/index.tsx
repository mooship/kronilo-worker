import type { CacheStorage, Console } from "@cloudflare/workers-types";

declare const caches: CacheStorage;

import { Hono } from "hono";
import { cors } from "hono/cors";
import { prettyJSON } from "hono/pretty-json";
import ky, { HTTPError } from "ky";
import { OpenAI } from "openai";
import {
	checkRateLimit,
	RATE_LIMIT_MAX,
	RATE_LIMIT_WINDOW,
	rateLimitMap,
} from "./rateLimit";
import { renderer } from "./renderer";
import type {
	ApiCache,
	ApiError,
	ApiSuccess,
	Bindings,
	OpenRouterKeyResponse,
} from "./types";
import { processInput, SYSTEM_PROMPT, validateApiResponse } from "./utils";

const app = new Hono<{ Bindings: Bindings }>();

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
	console.log(`[${new Date().toISOString()}] ${method} ${url} from IP: ${ip}`);
	await next();
});

app.get("/", (c) => {
	return c.render(<h1>Kronilo - Cron Expression Translator</h1>);
});

app.get("/health", (c) => {
	return c.json({
		status: "ok",
		rateLimit: {
			max: RATE_LIMIT_MAX,
			windowMs: RATE_LIMIT_WINDOW,
			currentUsage: rateLimitMap.size,
		},
	});
});

const CACHE_VERSION = "v2";
const MODEL = "google/gemma-3n-e4b-it:free";

app.post("/api/translate", async (c) => {
	try {
		const OPENROUTER_API_KEY = c.env.OPENROUTER_API_KEY;

		if (!OPENROUTER_API_KEY) {
			return c.json(
				{
					error: "Missing OPENROUTER_API_KEY environment variable",
				} satisfies ApiError,
				500,
			);
		}

		const { input = "" } = await c.req.json<{ input?: string }>();
		const trimmedInput = processInput(input);
		if (trimmedInput.length > 200) {
			return c.json(
				{ error: "Input too long (max 200 characters)" } satisfies ApiError,
				413,
			);
		}
		if (!trimmedInput) {
			return c.json({ error: "Missing input field" } satisfies ApiError, 400);
		}

		const ip =
			c.req.header("CF-Connecting-IP") ||
			c.req.header("x-forwarded-for") ||
			"unknown";
		if (!checkRateLimit(ip)) {
			return c.json(
				{ error: "Rate limit exceeded. Try again later." } satisfies ApiError,
				429,
			);
		}

		const cacheKey = new Request(
			`https://cache.kronilo/translate?version=${CACHE_VERSION}&input=${encodeURIComponent(trimmedInput)}`,
		);
		const cache = caches.default;
		const cached = await cache.match(cacheKey);
		if (cached) {
			const cachedData = await cached.json();
			return c.json(cachedData as ApiCache);
		}

		const openai = new OpenAI({
			apiKey: OPENROUTER_API_KEY,
			baseURL: "https://openrouter.ai/api/v1",
			defaultHeaders: {
				"HTTP-Referer":
					c.req.header("origin") || "https://kronilo.timothybrits.com",
				"X-Title": "Kronilo Worker - Cron Translator",
			},
		});

		const makeApiCall = async (attempt: number): Promise<ApiSuccess> => {
			const response = await openai.chat.completions.create({
				model: MODEL,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: trimmedInput },
				],
				max_tokens: 50,
				temperature: attempt > 1 ? 0.1 : 0,
			});

			const output = response.choices?.[0]?.message?.content?.trim() ?? "";

			const validation = validateApiResponse(output);
			if (!validation.isValid) {
				throw new Error(validation.error || "Invalid response format");
			}

			return {
				cron: output,
				model: MODEL,
				input: trimmedInput,
			};
		};

		let result: ApiSuccess | null = null;
		let lastError: unknown = null;

		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				result = await makeApiCall(attempt);
				break;
			} catch (err) {
				lastError = err;
				console.error(`Model ${MODEL} attempt ${attempt} failed:`, err);

				if (attempt === 2) {
					break;
				}

				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}

		if (!result) {
			return c.json(
				{
					error:
						"Could not translate input to a valid cron expression after retrying",
					details: {
						input: trimmedInput,
						model: MODEL,
						attempts: 2,
						lastError: lastError,
					},
				} satisfies ApiError,
				400,
			);
		}

		c.executionCtx.waitUntil(
			cache.put(
				cacheKey,
				new Response(JSON.stringify(result), {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": "max-age=604800",
						"X-Content-Type-Options": "nosniff",
						"X-Frame-Options": "DENY",
					},
				}),
			),
		);

		return c.json(result satisfies ApiSuccess);
	} catch (err) {
		console.error("Error in /api/translate:", err);
		return c.json(
			{ error: "Internal server error", details: err } satisfies ApiError,
			500,
		);
	}
});

app.get("/openrouter/rate-limit", async (c) => {
	const OPENROUTER_API_KEY = c.env.OPENROUTER_API_KEY;
	if (!OPENROUTER_API_KEY) {
		return c.json(
			{
				error: "Missing OPENROUTER_API_KEY environment variable",
			} satisfies ApiError,
			500,
		);
	}

	try {
		const res = await ky.get("https://openrouter.ai/api/v1/auth/key", {
			headers: {
				Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			},
		});

		const rateLimitHeaders = {
			"x-ratelimit-limit": res.headers.get("x-ratelimit-limit"),
			"x-ratelimit-remaining": res.headers.get("x-ratelimit-remaining"),
			"x-ratelimit-reset": res.headers.get("x-ratelimit-reset"),
			"x-ratelimit-used": res.headers.get("x-ratelimit-used"),
		};

		if (res.status === 429) {
			const errorBody = await res.text();
			return c.json(
				{
					rateLimited: true,
					status: res.status,
					details: errorBody,
					rateLimit: rateLimitHeaders,
				},
				200,
			);
		}

		if (res.status === 402) {
			const errorBody = await res.text();
			return c.json(
				{
					rateLimited: true,
					status: res.status,
					details: errorBody,
					rateLimit: rateLimitHeaders,
				},
				200,
			);
		}

		if (!res.ok) {
			const errorBody = await res.text();
			return c.json(
				{
					error: "Unexpected error",
					status: res.status,
					details: errorBody,
				},
				500,
			);
		}

		const data: OpenRouterKeyResponse = await res.json();
		const isRateLimited =
			typeof data.data?.limit === "number" &&
			typeof data.data?.usage === "number"
				? data.data.usage >= data.data.limit
				: false;

		return c.json(
			{
				rateLimited: isRateLimited,
				status: res.status,
				ok: res.ok,
				rateLimit: rateLimitHeaders,
				credits: data.data?.limit ?? null,
				usage: data.data?.usage ?? null,
				isFreeTier: data.data?.is_free_tier ?? null,
			},
			200,
		);
	} catch (err) {
		if (err instanceof HTTPError && err.response) {
			const errorBody = await err.response.text();
			return new Response(errorBody, {
				status: err.response.status,
				headers: { "Content-Type": "application/json" },
			});
		}
		console.error("Error checking OpenRouter rate limit:", err);
		return c.json(
			{
				error: "Failed to check OpenRouter rate limit",
				details: err,
			} satisfies ApiError,
			500,
		);
	}
});

// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Workers global
declare var Request: any;
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Workers global
declare var Response: any;
declare var console: Console;

export default app;
