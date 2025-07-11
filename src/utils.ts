export const SYSTEM_PROMPT = `
You are a utility that translates plain English into valid Unix cron expressions.

Only respond with a valid 5-field cron expression in this format:
* * * * *

Do not add any explanation or extra text.
`.trim();

export function sanitizeInput(input: string): string {
	return Array.from(input)
		.filter((c) => c >= " " && c !== "\x7F")
		.join("");
}

export function isValidCron(cron: string): boolean {
	const cronRegex =
		/^((\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}|\d{1,2}-\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2})\s+){4}(\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}|\d{1,2}-\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2})$/;
	return cronRegex.test(cron.trim());
}
