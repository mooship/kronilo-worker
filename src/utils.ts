export const SYSTEM_PROMPT = `
You are a utility that translates plain English into valid Unix cron expressions.

Only respond with a valid 5-field cron expression in this format:
* * * * *

Do not add any explanation or extra text.
`.trim();

export const WHITESPACE_REGEX = /\s+/g;

export function sanitizeInput(input: string): string {
	return Array.from(input)
		.filter((c) => c >= " " && c !== "\x7F")
		.join("");
}

export function processInput(input: string): string {
	return sanitizeInput(
		input.trim().toLowerCase().replace(WHITESPACE_REGEX, " "),
	);
}

export function isValidCron(cron: string): boolean {
	const trimmed = cron.trim();
	const parts = trimmed.split(/\s+/);

	if (parts.length !== 5) {
		return false;
	}

	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

	const minutePattern =
		/^(\*|([0-5]?\d)(,([0-5]?\d))*|([0-5]?\d)-([0-5]?\d)|\*\/([1-5]?\d)|([0-5]?\d)\/([1-5]?\d))$/;
	const hourPattern =
		/^(\*|([01]?\d|2[0-3])(,([01]?\d|2[0-3]))*|([01]?\d|2[0-3])-([01]?\d|2[0-3])|\*\/([01]?\d|2[0-3])|([01]?\d|2[0-3])\/([01]?\d|2[0-3]))$/;
	const dayPattern =
		/^(\*|([12]?\d|3[01])(,([12]?\d|3[01]))*|([12]?\d|3[01])-([12]?\d|3[01])|\*\/([12]?\d|3[01])|([12]?\d|3[01])\/([12]?\d|3[01]))$/;
	const monthPattern =
		/^(\*|([1-9]|1[0-2])(,([1-9]|1[0-2]))*|([1-9]|1[0-2])-([1-9]|1[0-2])|\*\/([1-9]|1[0-2])|([1-9]|1[0-2])\/([1-9]|1[0-2]))$/;
	const dowPattern = /^(\*|[0-6](,[0-6])*|[0-6]-[0-6]|\*\/[0-6]|[0-6]\/[0-6])$/;

	return (
		minutePattern.test(minute) &&
		hourPattern.test(hour) &&
		dayPattern.test(dayOfMonth) &&
		monthPattern.test(month) &&
		dowPattern.test(dayOfWeek)
	);
}

export function validateApiResponse(response: string): {
	isValid: boolean;
	error?: string;
} {
	if (!response || typeof response !== "string") {
		return { isValid: false, error: "Empty or invalid response" };
	}

	const trimmed = response.trim();

	const invalidPatterns = [
		/^(here|the|this|that|it|expression|cron)/i,
		/^(```|`)/,
		/explanation|description|means|represents/i,
		/\n/,
	];

	for (const pattern of invalidPatterns) {
		if (pattern.test(trimmed)) {
			return {
				isValid: false,
				error: `Response contains invalid pattern: ${trimmed}`,
			};
		}
	}

	if (!isValidCron(trimmed)) {
		return { isValid: false, error: `Invalid cron format: ${trimmed}` };
	}

	return { isValid: true };
}
