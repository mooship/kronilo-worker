import type { KVNamespace } from "@cloudflare/workers-types";

export interface Bindings {
	OPENROUTER_API_KEY: string;
	RATE_LIMIT_KV: KVNamespace;
}

export interface ApiError {
	error: string;
	rateLimitType?: "daily" | "perUser";
	details?: unknown;
}

export interface ApiSuccess {
	cron: string;
	model: string;
	input: string;
}

export interface ApiCache {
	cron: string;
	model: string;
	input: string;
}

export interface OpenRouterKeyResponse {
	data?: {
		label?: string;
		usage?: number;
		limit?: number | null;
		is_free_tier?: boolean;
	};
}

export interface TranslateRequestBody {
	input: string;
}

export interface Metrics {
	start: number;
	cacheHit: boolean;
	model: string | null;
	attempts: number;
	error: string | null;
	rateLimit: boolean;
	timeout: boolean;
}
