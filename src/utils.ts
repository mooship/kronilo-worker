/**
 * Utility functions for processing cron expressions and input sanitization.
 */

export const SYSTEM_PROMPT = `
You are a strict utility that converts plain English into a valid 5-field Unix cron expression.

Only output a single line in this format:
* * * * *

If the input is invalid or untranslatable, respond with:
invalid

Do not explain, comment, or include any extra text.
`.trim();

/**
 * Regex to match all whitespace characters.
 */

export const WHITESPACE_REGEX = /\s+/g;

/**
 * Removes non-printable and control characters from input string.
 * @param input - The input string to sanitize.
 * @returns Sanitized string with only printable characters.
 */

export function sanitizeInput(input: string): string {
	return Array.from(input)
		.filter((c) => c >= " " && c !== "\x7F")
		.join("");
}

/**
 * Processes input by trimming, lowercasing, normalizing whitespace, and sanitizing.
 * @param input - The input string to process.
 * @returns Processed string.
 */

export function processInput(input: string): string {
	return sanitizeInput(
		input.trim().toLowerCase().replace(WHITESPACE_REGEX, " "),
	);
}

/**
 * Validates if a string is a valid 5-field Unix cron expression.
 * @param cron - The cron string to validate.
 * @returns True if valid, false otherwise.
 */

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

/**
 * Validates the API response to ensure it is a valid cron expression and does not contain unwanted patterns.
 * @param response - The response string to validate.
 * @returns Object with isValid boolean and optional error message.
 */

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
