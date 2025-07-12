/**
 * System prompt for AI model to translate plain English into Unix cron expressions.
 * Instructs the model to return only valid 5-field cron expressions without explanations.
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
 * Regular expression to match one or more whitespace characters.
 * Used for normalizing whitespace in input strings.
 */
export const WHITESPACE_REGEX = /\s+/g;

/**
 * Sanitizes input string by filtering out control characters and non-printable characters.
 * Keeps only characters that are space (ASCII 32) or higher, excluding DEL (ASCII 127).
 *
 * @param input - The input string to sanitize
 * @returns The sanitized string with only printable characters
 */
export function sanitizeInput(input: string): string {
	return Array.from(input)
		.filter((c) => c >= " " && c !== "\x7F")
		.join("");
}

/**
 * Processes input string by sanitizing, trimming, converting to lowercase,
 * and normalizing whitespace to single spaces.
 *
 * @param input - The input string to process
 * @returns The processed and normalized string
 */
export function processInput(input: string): string {
	return sanitizeInput(
		input.trim().toLowerCase().replace(WHITESPACE_REGEX, " "),
	);
}

/**
 * Validates if a string is a valid Unix cron expression.
 * Checks for exactly 5 fields (minute, hour, day of month, month, day of week)
 * and validates each field against appropriate patterns.
 *
 * Supported formats for each field:
 * - asterisk (*): matches any value
 * - number: specific value
 * - number1,number2: list of values
 * - number1-number2: range of values
 * - asterisk/number: step values (every nth value)
 * - number/step: step values starting from number
 *
 * @param cron - The cron expression string to validate
 * @returns True if the cron expression is valid, false otherwise
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
 * Validates the API response from the AI model to ensure it contains a valid cron expression.
 * Checks for common invalid patterns and validates the cron format.
 *
 * Invalid patterns include:
 * - Responses starting with common words like "here", "the", "this", etc.
 * - Code block markers (backticks)
 * - Explanatory text containing words like "explanation", "description", etc.
 * - Multi-line responses
 *
 * @param response - The response string from the AI model
 * @returns Object containing validation result and optional error message
 * @returns.isValid - Whether the response is valid
 * @returns.error - Error message if validation fails
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
