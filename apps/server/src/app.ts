import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import chunksRoutes from "./routes/chunks";
import recordingsRoutes from "./routes/recordings";
import sessionsRoutes from "./routes/sessions";
import transcriptionsRoutes from "./routes/transcriptions";

const app = new Hono().basePath("/api");

app.use(logger());
app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
  }),
);

app.get("/", (c) => c.text("OK"));
app.get("/health", (c) =>
  c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    hasOpenAI: !!process.env.OPENAI_API_KEY,
    hasDB: !!process.env.DATABASE_URL,
  }),
);

app.route("/sessions", sessionsRoutes);
app.route("/recordings", recordingsRoutes);
app.route("/chunks", chunksRoutes);
app.route("/transcriptions", transcriptionsRoutes);

export default app;
