export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW = 5 * 60 * 1000;
export const rateLimitMap = new Map<string, { count: number; last: number }>();

export function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);

	if (!entry || now - entry.last > RATE_LIMIT_WINDOW) {
		rateLimitMap.set(ip, { count: 1, last: now });
		cleanupOldEntries(now);
		return true;
	}

	if (entry.count >= RATE_LIMIT_MAX) {
		return false;
	}

	entry.count++;
	entry.last = now;
	return true;
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
