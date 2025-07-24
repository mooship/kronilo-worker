import type { MiddlewareHandler } from "hono";
import { logInfo } from "../utils";

export const loggingMiddleware: MiddlewareHandler = async (c, next) => {
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
};
