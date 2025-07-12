import type { KVNamespace } from "@cloudflare/workers-types";

export const RATE_LIMIT_MAX = 3; // 3 requests per user per hour
export const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour window
export const DAILY_API_LIMIT = 45; // Reserve 5 calls for testing/admin
export const rateLimitMap = new Map<string, { count: number; last: number }>();

// Daily usage will be stored in KV for persistence
const DAILY_USAGE_KEY = "daily_usage";

// Cache daily usage in memory to reduce KV reads/writes
let cachedDailyUsage: {
	count: number;
	date: string;
	lastWrite: number;
} | null = null;
const WRITE_DEBOUNCE_MS = 5000; // Only write to KV every 5 seconds max

export async function checkRateLimit(
	ip: string,
	kv: KVNamespace,
): Promise<boolean> {
	const now = Date.now();
	const today = new Date().toDateString();

	// Get daily usage (from cache or KV)
	const dailyUsage = await getDailyUsageInternal(kv, today);

	// Check global daily limit first
	if (dailyUsage.count >= DAILY_API_LIMIT) {
		return false;
	}

	// Check per-user rate limit (in-memory, resets on worker restart)
	const entry = rateLimitMap.get(ip);

	if (!entry || now - entry.last > RATE_LIMIT_WINDOW) {
		rateLimitMap.set(ip, { count: 1, last: now });
		dailyUsage.count++;

		// Update cache and write to KV (debounced)
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

	// Update cache and write to KV (debounced)
	await updateDailyUsage(kv, dailyUsage, now);
	return true;
}

async function getDailyUsageInternal(kv: KVNamespace, today: string) {
	// Use cached value if it's fresh and from today
	if (cachedDailyUsage && cachedDailyUsage.date === today) {
		return cachedDailyUsage;
	}

	// Read from KV
	const dailyUsageStr = await kv.get(DAILY_USAGE_KEY);
	let dailyUsage = { count: 0, date: today, lastWrite: 0 };

	if (dailyUsageStr) {
		const stored = JSON.parse(dailyUsageStr);
		// Reset if it's a new day
		if (stored.date === today) {
			dailyUsage = { ...stored, lastWrite: stored.lastWrite || 0 };
		}
	}

	// Cache the result
	cachedDailyUsage = dailyUsage;
	return dailyUsage;
}

async function updateDailyUsage(
	kv: KVNamespace,
	dailyUsage: { count: number; date: string; lastWrite: number },
	now: number,
) {
	// Update cache immediately
	cachedDailyUsage = { ...dailyUsage, lastWrite: now };

	// Only write to KV if enough time has passed (debouncing)
	if (now - dailyUsage.lastWrite > WRITE_DEBOUNCE_MS) {
		await kv.put(DAILY_USAGE_KEY, JSON.stringify(cachedDailyUsage));
		cachedDailyUsage.lastWrite = now;
	}
}

export async function getDailyUsage(kv: KVNamespace) {
	const today = new Date().toDateString();
	const dailyUsage = await getDailyUsageInternal(kv, today);

	return {
		count: dailyUsage.count,
		date: dailyUsage.date,
		remaining: DAILY_API_LIMIT - dailyUsage.count,
	};
}

function cleanupOldEntries(now: number): void {
	if (Math.random() < 0.1) {
		for (const [ip, entry] of rateLimitMap.entries()) {
			if (now - entry.last > RATE_LIMIT_WINDOW) {
				rateLimitMap.delete(ip);
			}
		}
	}
}
