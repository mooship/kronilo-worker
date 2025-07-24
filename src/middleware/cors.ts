import { cors } from "hono/cors";

export const corsMiddleware = cors({
	origin: [
		"https://kronilo.timothybrits.com",
		"https://kronilo.onrender.com",
		"http://localhost:5173",
	],
	allowMethods: ["GET", "POST", "OPTIONS"],
	allowHeaders: ["Content-Type"],
});
