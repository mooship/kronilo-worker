# Kronilo Worker - Cron Expression Translator

A Cloudflare Worker that translates natural language into valid Unix cron expressions using OpenRouter AI models.

## Setup

1. Install dependencies:

```txt
bun install
```

2. Set up your OpenRouter API key in `.dev.vars`:

```txt
OPENROUTER_API_KEY=your_actual_api_key_here
```

3. Run locally:

```txt
bun run dev
```

4. Deploy to Cloudflare:

```txt
bun run deploy
```

## API Usage

### POST /api/translate

Translate natural language text to a cron expression.

**Request:**

```json
{
  "input": "every day at 3 PM"
}
```

**Response:**

```json
{
  "cron": "0 15 * * *",
  "model": "google/gemma-3n-e4b-it:free",
  "input": "every day at 3 PM"
}
```

### GET /api/health

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "rateLimit": {
    "perUser": {
      "max": 3,
      "windowMs": 3600000,
      "currentUsers": 1
    },
    "daily": {
      "limit": 45,
      "used": 12,
      "remaining": 33,
      "date": "Sat Jul 12 2025"
    }
  }
}
```

## Environment Variables

- `OPENROUTER_API_KEY`: Your OpenRouter API key (required)

## Production Deployment

Before deploying to production, set the environment variable in Cloudflare Workers:

```txt
wrangler secret put OPENROUTER_API_KEY
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
bun run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>();
```

## License

This project is licensed under the GNU Affero General Public License (AGPL). See the [LICENSE](LICENSE) file for details.
