import type { KVNamespace } from "@cloudflare/workers-types";

/**
 * Type definitions for the OpenRouter API and related structures.
 */

export type Bindings = {
	OPENROUTER_API_KEY: string;
	RATE_LIMIT_KV: KVNamespace;
};

/**
 * Structure for API error responses.
 */

export interface ApiError {
	error: string;
	rateLimitType?: "daily" | "perUser";
	details?: unknown;
}

/**
 * Structure for successful API responses.
 */

export interface ApiSuccess {
	cron: string;
	model: string;
	input: string;
	language: string;
}

/**
 * Structure for cached API responses.
 */

export interface ApiCache {
	cron: string;
	model: string;
	input: string;
}

/**
 * Structure for OpenRouter API key response.
 */

export interface OpenRouterKeyResponse {
	data?: {
		label?: string;
		usage?: number;
		limit?: number | null;
		is_free_tier?: boolean;
	};
}
