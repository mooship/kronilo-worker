import { type CacheStorage, Response } from "@cloudflare/workers-types";

declare const caches: CacheStorage;

import { Hono } from "hono";
import { cors } from "hono/cors";
import { OpenAI } from "openai";
import { renderer } from "./renderer";

type Bindings = {
	OPENROUTER_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use(
	"/*",
	cors({
		origin: [
			"https://kronilo.timothybrits.com",
			"https://kronilo.onrender.com",
		],
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type"],
	}),
);

app.use(renderer);

const SYSTEM_PROMPT = `
You are a utility that translates plain English into valid Unix cron expressions.

Only respond with a valid 5-field cron expression in this format:
* * * * *

Do not add any explanation or extra text.
`.trim();

function isValidCron(cron: string): boolean {
	const cronRegex =
		/^((\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}|\d{1,2}-\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2})\s+){4}(\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}|\d{1,2}-\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2})$/;
	return cronRegex.test(cron.trim());
}

app.get("/", (c) => {
	return c.render(<h1>Kronilo Worker - Cron Expression Translator</h1>);
});

app.post("/api/translate", async (c) => {
	try {
		const OPENROUTER_API_KEY = c.env.OPENROUTER_API_KEY;

		if (!OPENROUTER_API_KEY) {
			return c.json(
				{ error: "Missing OPENROUTER_API_KEY environment variable" },
				500,
			);
		}

		const { input = "" } = await c.req.json<{ input?: string }>();
		const trimmedInput = input.trim();
		if (!trimmedInput) {
			return c.json({ error: "Missing input field" }, 400);
		}

		const cacheKey = new Request(
			`https://cache.kronilo/translate?input=${encodeURIComponent(trimmedInput)}`,
		);
		const cache = caches.default;
		const cached = await cache.match(cacheKey);
		if (cached) {
			const cachedData = await cached.json();
			return c.json(cachedData as Record<string, unknown>);
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

		for (const model of models.slice(0, 2)) {
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
					const result = {
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
								},
							}),
						),
					);
					return c.json(result);
				}
			} catch {}
		}

		return c.json(
			{
				error: "Could not translate input to a valid cron expression",
				input: trimmedInput,
			},
			400,
		);
	} catch {
		return c.json({ error: "Internal server error" }, 500);
	}
});

// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Workers global
declare var Request: any;

export default app;
