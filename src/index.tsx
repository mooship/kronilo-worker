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
import type { ApiCache, ApiError, ApiSuccess, Bindings } from "./types";
import { isValidCron, SYSTEM_PROMPT, sanitizeInput } from "./utils";

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
	return c.render(<h1>Kronilo Worker - Cron Expression Translator</h1>);
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
const MODELS = [
	"google/gemma-3n-e4b-it:free",
	"meta-llama/llama-3.2-3b-instruct:free",
	"mistralai/mistral-7b-instruct:free",
];
const WHITESPACE_REGEX = /\s+/g;

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
		let trimmedInput = input
			.trim()
			.toLowerCase()
			.replace(WHITESPACE_REGEX, " ");
		if (trimmedInput.length > 200) {
			return c.json(
				{ error: "Input too long (max 200 characters)" } satisfies ApiError,
				413,
			);
		}
		trimmedInput = sanitizeInput(trimmedInput);
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

		let result: ApiSuccess | null = null;

		const modelPromises = MODELS.map(async (model) => {
			try {
				const response = await openai.chat.completions.create({
					model,
					messages: [
						{ role: "system", content: SYSTEM_PROMPT },
						{ role: "user", content: trimmedInput },
					],
					max_tokens: 50,
					temperature: 0,
				});
				const output = response.choices?.[0]?.message?.content?.trim() ?? "";
				if (isValidCron(output)) {
					return {
						cron: output,
						model,
						input: trimmedInput,
					} satisfies ApiSuccess;
				}
				return null;
			} catch (err) {
				console.error(`Model ${model} failed:`, err);
				return null;
			}
		});

		const results = await Promise.all(modelPromises);
		result = results.find((r) => r !== null) || null;

		if (result) {
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
		}

		return c.json(
			{
				error: "Could not translate input to a valid cron expression",
				details: { input: trimmedInput, triedModels: MODELS },
			} satisfies ApiError,
			400,
		);
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
		const res = await ky.get("https://openrouter.ai/api/v1/models", {
			headers: {
				Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			},
		});

		if (!res.ok) {
			const errorBody = await res.text();
			return c.json(
				{
					rateLimited: true,
					status: res.status,
					details: errorBody,
				},
				200,
			);
		}

		const rateLimitHeaders = {
			"x-ratelimit-limit": res.headers.get("x-ratelimit-limit"),
			"x-ratelimit-remaining": res.headers.get("x-ratelimit-remaining"),
			"x-ratelimit-reset": res.headers.get("x-ratelimit-reset"),
			"x-ratelimit-used": res.headers.get("x-ratelimit-used"),
		};

		return c.json(
			{
				rateLimited: false,
				status: res.status,
				ok: res.ok,
				rateLimit: rateLimitHeaders,
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
