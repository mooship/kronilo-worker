import type { KVNamespace } from "@cloudflare/workers-types";

export const RATE_LIMIT_MAX = 3;
export const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
export const DAILY_API_LIMIT = 45;
export const rateLimitMap = new Map<string, { count: number; last: number }>();

const DAILY_USAGE_KEY = "daily_usage";

let cachedDailyUsage: {
	count: number;
	date: string;
	lastWrite: number;
} | null = null;
const WRITE_DEBOUNCE_MS = 5000;

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
