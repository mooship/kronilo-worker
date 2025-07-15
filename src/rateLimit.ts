import type { KVNamespace } from "@cloudflare/workers-types";

/**
 * Rate limiting constants and functions for managing API usage.
 */

export const RATE_LIMIT_MAX = 2;
export const RATE_LIMIT_WINDOW = 24 * 60 * 60 * 1000;
export const DAILY_API_LIMIT = 20;
export const BURST_WINDOW_MS = 60 * 1000;
export const BURST_LIMIT = 2;

/**
 * Key used for storing daily usage in KV.
 */

const DAILY_USAGE_KEY = "daily_usage";

/**
 * Cached daily usage object to reduce KV reads.
 */

let cachedDailyUsage: {
	count: number;
	date: string;
	lastWrite: number;
} | null = null;
/**
 * Debounce time for writing daily usage to KV in milliseconds.
 */

const WRITE_DEBOUNCE_MS = 2000;

/**
 * Checks if the given IP is within rate limits and updates usage counters.
 * @param ip - The user's IP address.
 * @param kv - The KVNamespace for storing rate limit data.
 * @returns True if allowed, false if rate limited.
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

	const userKey = `rate_${ip}`;
	let timestamps: number[] = [];
	const stored = await kv.get(userKey);
	if (stored) {
		try {
			timestamps = JSON.parse(stored);
		} catch {}
	}

	timestamps = timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW);
	if (timestamps.length >= RATE_LIMIT_MAX) {
		return false;
	}

	const burstCount = timestamps.filter(
		(ts) => now - ts < BURST_WINDOW_MS,
	).length;
	if (burstCount >= BURST_LIMIT) {
		return false;
	}

	timestamps.push(now);
	await kv.put(userKey, JSON.stringify(timestamps), {
		expirationTtl: Math.ceil(RATE_LIMIT_WINDOW / 1000),
	});

	dailyUsage.count++;
	await updateDailyUsage(kv, dailyUsage, now);
	return true;
}

/**
 * Internal helper to get daily usage from KV or cache.
 * @param kv - The KVNamespace.
 * @param today - Today's date string.
 * @returns Daily usage object.
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
 * Updates daily usage in KV if debounce time has passed.
 * @param kv - The KVNamespace.
 * @param dailyUsage - The daily usage object.
 * @param now - Current timestamp.
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
 * Gets the current daily usage and remaining API calls for today.
 * @param kv - The KVNamespace.
 * @returns Object with count, date, and remaining calls.
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
