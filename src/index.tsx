import type { CacheStorage } from "@cloudflare/workers-types";

declare const caches: CacheStorage;

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
	rateLimitMap,
} from "./rateLimit";
import { renderer } from "./renderer";
import type { ApiCache, ApiError, ApiSuccess, Bindings } from "./types";
import { processInput, SYSTEM_PROMPT, validateApiResponse } from "./utils";

/**
 * Main Hono application instance for the Kronilo cron translation service.
 * Configured with Cloudflare Workers bindings for KV storage and environment variables.
 */
const app = new Hono<{ Bindings: Bindings }>();

/**
 * Configure CORS middleware to allow requests from approved origins.
 * Permits access from production domains and local development.
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
 */
app.get("/", (c) => {
	return c.render(<h1>Kronilo - Cron Expression Translator</h1>);
});

/**
 * Health check endpoint that provides service status and rate limit information.
 * Returns current rate limiting stats including per-user and daily usage data.
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
				currentUsers: rateLimitMap.size,
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
 */
const CACHE_VERSION = "v4";

/**
 * Primary AI model for cron expression translation via OpenRouter.
 * Google Gemma 3 27B Instruct - A high-quality instruction-following model
 * optimized for precise, structured outputs like cron expressions.
 * Uses the free tier to minimize costs while maintaining reliability.
 */
const PRIMARY_MODEL = "google/gemma-3-27b-it:free";

/**
 * Backup AI model used when the primary model fails or is unavailable.
 * Qwen 3 14B - Alibaba's mid-size language model with strong reasoning capabilities.
 * Provides a different model architecture as fallback to increase success rate
 * when the primary Google model encounters issues or rate limits.
 */
const BACKUP_MODEL = "qwen/qwen3-14b:free";

/**
 * Main API endpoint for translating plain English input to cron expressions.
 *
 * Features:
 * - Rate limiting (per-user and daily limits)
 * - Response caching for identical inputs
 * - Retry logic with primary and backup AI models
 * - Input validation and sanitization
 * - Comprehensive error handling
 *
 * @param c - Hono context containing request data and environment bindings
 * @returns JSON response with cron expression or error details
 */
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
		if (!(await checkRateLimit(ip, c.env.RATE_LIMIT_KV))) {
			const dailyUsage = await getDailyUsage(c.env.RATE_LIMIT_KV);
			const isDailyLimit = dailyUsage.remaining <= 0;
			const errorMessage = isDailyLimit
				? "Daily API limit reached. Please try again tomorrow."
				: "Rate limit exceeded. Please try again later.";

			return c.json(
				{
					error: errorMessage,
					rateLimitType: isDailyLimit ? "daily" : "perUser",
					details: {
						daily: dailyUsage,
						perUser: {
							maxPerHour: RATE_LIMIT_MAX,
							windowMs: RATE_LIMIT_WINDOW,
						},
					},
				} satisfies ApiError,
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

		/**
		 * Makes an API call to the specified AI model for cron translation.
		 * @param model - The AI model identifier to use
		 * @param attempt - The attempt number (affects temperature setting)
		 * @returns Promise resolving to a successful API response
		 * @throws Error if the model returns an invalid response
		 */
		const makeApiCall = async (
			model: string,
			attempt: number,
		): Promise<ApiSuccess> => {
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
				{
					timeout: 7_000,
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
			};
		};

		let result: ApiSuccess | null = null;
		let lastError: unknown = null;
		let usedModel: string = PRIMARY_MODEL;

		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				result = await makeApiCall(PRIMARY_MODEL, attempt);
				usedModel = PRIMARY_MODEL;
				break;
			} catch (err) {
				lastError = err;
				console.error(
					`Primary model ${PRIMARY_MODEL} attempt ${attempt} failed:`,
					err,
				);
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}

		if (!result) {
			try {
				result = await makeApiCall(BACKUP_MODEL, 1);
				usedModel = BACKUP_MODEL;
			} catch (err) {
				lastError = err;
				console.error(`Backup model ${BACKUP_MODEL} failed:`, err);
			}
		}

		if (!result) {
			return c.json(
				{
					error:
						"Could not translate input to a valid cron expression after retrying",
					details: {
						input: trimmedInput,
						model: usedModel,
						attempts: 3,
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
						"Cache-Control": "max-age=1814400",
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

// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Workers global
declare var Request: any;
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Workers global
declare var Response: any;

export default app;
