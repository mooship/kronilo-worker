import type { KVNamespace } from "@cloudflare/workers-types";

export type Bindings = {
	OPENROUTER_API_KEY: string;
	RATE_LIMIT_KV: KVNamespace;
};

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
