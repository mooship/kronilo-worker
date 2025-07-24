import { Hono } from "hono";
import type { Bindings } from "../interfaces";
import {
	getDailyUsage,
	DAILY_API_LIMIT,
	RATE_LIMIT_MAX,
	RATE_LIMIT_WINDOW,
} from "../rateLimit";

const health = new Hono<{ Bindings: Bindings }>();

health.get("/", async (c) => {
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

export default health;
