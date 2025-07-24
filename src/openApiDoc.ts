export const openApiDoc = {
	openapi: "3.0.0",
	info: {
		title: "Kronilo API Documentation",
		version: "1.0.0",
		description: "API documentation for Kronilo endpoints",
	},
	paths: {
		"/": {
			get: {
				summary: "Root endpoint",
				responses: { "200": { description: "HTML page" } },
			},
		},
		"/health": {
			get: {
				summary: "Health check",
				responses: { "200": { description: "OK" } },
			},
		},
		"/api/translate": {
			post: {
				summary: "Translate plain English to cron expression",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: { input: { type: "string" } },
								required: ["input"],
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Translation result",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										cron: { type: "string" },
										model: { type: "string" },
										input: { type: "string" },
									},
								},
							},
						},
					},
					"400": { description: "Bad request" },
					"429": { description: "Rate limited" },
					"500": { description: "Internal error" },
				},
			},
		},
	},
};
