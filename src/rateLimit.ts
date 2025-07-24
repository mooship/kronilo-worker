import type { KVNamespace } from "@cloudflare/workers-types";
import type { IpAddress, Timestamps } from "./types";
import { logError } from "./utils";

export const RATE_LIMIT_MAX: number = 5;
export const RATE_LIMIT_WINDOW: number = 24 * 60 * 60 * 1000;
export const DAILY_API_LIMIT: number = 50;
export const BURST_WINDOW_MS: number = 60 * 1000;
export const BURST_LIMIT: number = 5;

const DAILY_USAGE_KEY: string = "daily_usage";
const DAILY_USAGE_TTL: number = 86400;
const USER_WINDOW_TTL: number = Math.ceil(RATE_LIMIT_WINDOW / 1000);
const USER_KEY_PREFIX: string = "rate_limit:ip:";

export async function checkRateLimit(
	ip: IpAddress,
	kv: KVNamespace,
): Promise<boolean> {
	if (!ip || ip === "unknown") {
		logError("RateLimit: missing or unknown IP", ip);
		return false;
	}
	const now: number = Date.now();
	const today: string = new Date().toISOString().slice(0, 10);
	const dailyKey: string = `${DAILY_USAGE_KEY}_${today}`;

	let count: number = 0;
	let incremented: boolean = false;
	try {
		count =
			(await kv.get(dailyKey).then((raw) => parseInt(raw || "0", 10))) || 0;
		if (count >= DAILY_API_LIMIT) {
			return false;
		}
		await kv.put(dailyKey, String(count + 1), {
			expirationTtl: DAILY_USAGE_TTL,
		});
		incremented = true;
	} catch (err) {
		logError("KV daily usage increment error", err);
	}
	if (!incremented) {
		return false;
	}

	const key: string = `${USER_KEY_PREFIX}${ip}`;
	let timestamps: Timestamps = [];
	try {
		const arr = await kv.get<Timestamps>(key, "json");
		if (Array.isArray(arr)) {
			timestamps = arr;
		}
	} catch (err) {
		logError("KV user timestamps get error", err);
	}

	const windowStart: number = now - RATE_LIMIT_WINDOW;
	timestamps = timestamps.filter((t) => t >= windowStart);
	if (timestamps.length >= RATE_LIMIT_MAX) {
		return false;
	}

	const burstStart: number = now - BURST_WINDOW_MS;
	if (timestamps.filter((t) => t >= burstStart).length >= BURST_LIMIT) {
		return false;
	}

	timestamps.push(now);
	try {
		await kv.put(key, JSON.stringify(timestamps), {
			expirationTtl: USER_WINDOW_TTL,
		});
	} catch (err) {
		logError("KV user timestamps put error", err);
	}

	return true;
}

export type DailyUsage = {
	count: number;
	date: string;
	remaining: number;
};

export async function getDailyUsage(kv: KVNamespace): Promise<DailyUsage> {
	const today: string = new Date().toISOString().slice(0, 10);
	const dailyKey: string = `${DAILY_USAGE_KEY}_${today}`;
	let count: number = 0;
	try {
		const raw = await kv.get(dailyKey);
		if (raw) {
			count = parseInt(raw, 10) || 0;
		}
	} catch (err) {
		logError("KV getDailyUsage error", err);
	}
	return {
		count,
		date: today,
		remaining: DAILY_API_LIMIT - count,
	};
}
