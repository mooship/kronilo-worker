import type { KVNamespace } from "@cloudflare/workers-types";

/**
 * Environment bindings for Cloudflare Worker.
 */
export type Bindings = {
	OPENROUTER_API_KEY: string;
	RATE_LIMIT_KV: KVNamespace;
};

/**
 * Error response for API endpoints.
 */
export interface ApiError {
	error: string;
	rateLimitType?: "daily" | "perUser";
	details?: unknown;
}

/**
 * Success response for cron translation API.
 */
export interface ApiSuccess {
	cron: string;
	model: string;
	input: string;
	language: string;
}

/**
 * Cached response structure for cron translation.
 */
export interface ApiCache {
	cron: string;
	model: string;
	input: string;
}

/**
 * Response structure for OpenRouter API key info.
 */
export interface OpenRouterKeyResponse {
	data?: {
		label?: string;
		usage?: number;
		limit?: number | null;
		is_free_tier?: boolean;
	};
}
