import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import { prettyJSON } from "hono/pretty-json";
import type { Bindings } from "./interfaces";
import { corsMiddleware } from "./middleware/cors";
import { loggingMiddleware } from "./middleware/logging";
import { openApiDoc } from "./openApiDoc";
import { renderer } from "./renderer";
import healthRoute from "./routes/health";
import translateRoute from "./routes/translate";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/doc", (c) => c.json(openApiDoc));
app.get("/ui", swaggerUI({ url: "/doc" }));

app.use("/*", corsMiddleware);

app.use(renderer);
app.use(prettyJSON());

app.use(loggingMiddleware);

app.get("/", (c) => c.render(<h1>Kronilo - Cron Expression Translator</h1>));

app.route("/health", healthRoute);
app.route("/api/translate", translateRoute);

export default app;
