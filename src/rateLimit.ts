import type { KVNamespace } from "@cloudflare/workers-types";

/**
 * Maximum requests per user per window.
 * Change this to adjust per-user rate limit.
 */
export const RATE_LIMIT_MAX = 3;
/**
 * Window duration in milliseconds for per-user rate limit.
 * Change this to adjust the time window for per-user rate limit.
 */
export const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
/**
 * Maximum daily API requests allowed.
 * Change this to adjust daily global API limit.
 */
export const DAILY_API_LIMIT = 50;
/**
 * Tracks per-user request counts and timestamps.
 * Used for in-memory rate limiting (not persisted).
 */
export const rateLimitMap = new Map<string, { count: number; last: number }>();

// KV key for storing daily usage stats
const DAILY_USAGE_KEY = "daily_usage";

let cachedDailyUsage: {
	count: number;
	date: string;
	lastWrite: number;
} | null = null;
// Debounce interval for KV writes (ms)
const WRITE_DEBOUNCE_MS = 2000;

/**
 * Checks if the given IP is within rate limits and updates usage.
 * Called by /api/translate endpoint before processing request.
 *
 * @param ip - User IP address
 * @param kv - Cloudflare KV namespace
 * @returns True if allowed, false if rate limited
 */
export async function checkRateLimit(
	ip: string,
	kv: KVNamespace,
): Promise<boolean> {
	const now = Date.now();
	const today = new Date().toDateString();

	const dailyUsage = await getDailyUsageInternal(kv, today);

	if (dailyUsage.count >= DAILY_API_LIMIT) {
		return false;
	}

	const entry = rateLimitMap.get(ip);

	if (!entry || now - entry.last > RATE_LIMIT_WINDOW) {
		rateLimitMap.set(ip, { count: 1, last: now });
		dailyUsage.count++;

		await updateDailyUsage(kv, dailyUsage, now);
		cleanupOldEntries(now);
		return true;
	}

	if (entry.count >= RATE_LIMIT_MAX) {
		return false;
	}

	entry.count++;
	entry.last = now;
	dailyUsage.count++;

	await updateDailyUsage(kv, dailyUsage, now);
	return true;
}

/**
 * Retrieves daily usage from KV or cache for the current day.
 * Used internally for rate limit checks and stats.
 *
 * @param kv - Cloudflare KV namespace
 * @param today - Current date string
 * @returns Daily usage object
 */
async function getDailyUsageInternal(kv: KVNamespace, today: string) {
	if (cachedDailyUsage && cachedDailyUsage.date === today) {
		return cachedDailyUsage;
	}

	const dailyUsageStr = await kv.get(DAILY_USAGE_KEY);
	let dailyUsage = { count: 0, date: today, lastWrite: 0 };

	if (dailyUsageStr) {
		const stored = JSON.parse(dailyUsageStr);
		if (stored.date === today) {
			dailyUsage = { ...stored, lastWrite: stored.lastWrite || 0 };
		}
	}

	cachedDailyUsage = dailyUsage;
	return dailyUsage;
}

/**
 * Updates daily usage in KV if debounce interval has passed.
 * Used internally to persist usage stats.
 *
 * @param kv - Cloudflare KV namespace
 * @param dailyUsage - Usage object
 * @param now - Current timestamp
 */
async function updateDailyUsage(
	kv: KVNamespace,
	dailyUsage: { count: number; date: string; lastWrite: number },
	now: number,
) {
	cachedDailyUsage = { ...dailyUsage, lastWrite: now };

	if (now - dailyUsage.lastWrite > WRITE_DEBOUNCE_MS) {
		await kv.put(DAILY_USAGE_KEY, JSON.stringify(cachedDailyUsage), {
			expirationTtl: 86400,
		});
		cachedDailyUsage.lastWrite = now;
	}
}

/**
 * Returns daily usage stats for the current day.
 * Used by /health endpoint for monitoring.
 *
 * @param kv - Cloudflare KV namespace
 * @returns Usage stats including count, date, and remaining
 */
export async function getDailyUsage(kv: KVNamespace) {
	const today = new Date().toDateString();
	const dailyUsage = await getDailyUsageInternal(kv, today);

	return {
		count: dailyUsage.count,
		date: dailyUsage.date,
		remaining: DAILY_API_LIMIT - dailyUsage.count,
	};
}

/**
 * Cleans up old entries in the rateLimitMap based on window expiration.
 * Used internally to prevent memory leaks in long-running workers.
 *
 * @param now - Current timestamp
 */
function cleanupOldEntries(now: number): void {
	if (Math.random() < 0.1) {
		for (const [ip, entry] of rateLimitMap.entries()) {
			if (now - entry.last > RATE_LIMIT_WINDOW) {
				rateLimitMap.delete(ip);
			}
		}
	}
}
