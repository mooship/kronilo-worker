import type { CacheStorage, Console } from "@cloudflare/workers-types";

declare const caches: CacheStorage;

import { Hono } from "hono";
import { cors } from "hono/cors";
import { prettyJSON } from "hono/pretty-json";
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
		let trimmedInput = input.trim();
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
			`https://cache.kronilo/translate?input=${encodeURIComponent(trimmedInput)}`,
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

		const models = [
			"google/gemma-3n-e2b-it:free",
			"mistralai/mistral-7b-instruct:free",
			"google/gemma-3-27b-it:free",
		];

		const triedModels: string[] = [];
		for (const model of models) {
			triedModels.push(model);
			try {
				const response = await openai.chat.completions.create({
					model,
					messages: [
						{ role: "system", content: SYSTEM_PROMPT },
						{ role: "user", content: trimmedInput },
					],
					max_tokens: 50,
					temperature: 0.1,
				});

				const output = response.choices?.[0]?.message?.content?.trim() ?? "";

				if (isValidCron(output)) {
					const result: ApiSuccess = {
						cron: output,
						model: model,
						input: trimmedInput,
					};
					c.executionCtx.waitUntil(
						cache.put(
							cacheKey,
							new Response(JSON.stringify(result), {
								headers: {
									"Content-Type": "application/json",
									"Cache-Control": "max-age=86400",
									"X-Content-Type-Options": "nosniff",
									"X-Frame-Options": "DENY",
								},
							}),
						),
					);
					return c.json(result satisfies ApiSuccess);
				}
			} catch (err) {
				console.error(`Model ${model} failed:`, err);
			}
		}

		return c.json(
			{
				error: "Could not translate input to a valid cron expression",
				details: { input: trimmedInput, triedModels },
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

// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Workers global
declare var Request: any;
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Workers global
declare var Response: any;
declare var console: Console;

export default app;
