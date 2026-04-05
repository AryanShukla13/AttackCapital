import { env } from "@my-better-t-app/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import chunksRoutes from "./routes/chunks";
import recordingsRoutes from "./routes/recordings";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
  }),
);

app.get("/", (c) => c.text("OK"));
app.get("/health", (c) => c.json({ status: "healthy", timestamp: new Date().toISOString() }));

app.route("/api/recordings", recordingsRoutes);
app.route("/api/chunks", chunksRoutes);

export default app;
