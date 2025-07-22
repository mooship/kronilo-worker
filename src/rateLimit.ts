import type { KVNamespace } from "@cloudflare/workers-types";

export const RATE_LIMIT_MAX = 2;
export const RATE_LIMIT_WINDOW = 24 * 60 * 60 * 1000;
export const DAILY_API_LIMIT = 20;
export const BURST_WINDOW_MS = 60 * 1000;
export const BURST_LIMIT = 2;

const DAILY_USAGE_KEY = "daily_usage";

let cachedDailyUsage: {
	count: number;
	date: string;
	lastWrite: number;
} | null = null;

const WRITE_DEBOUNCE_MS = 2000;

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

export async function getDailyUsage(kv: KVNamespace) {
	const today = new Date().toDateString();
	const dailyUsage = await getDailyUsageInternal(kv, today);

	return {
		count: dailyUsage.count,
		date: dailyUsage.date,
		remaining: DAILY_API_LIMIT - dailyUsage.count,
	};
}
