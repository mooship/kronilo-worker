export type Bindings = {
	OPENROUTER_API_KEY: string;
};

export interface ApiError {
	error: string;
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
