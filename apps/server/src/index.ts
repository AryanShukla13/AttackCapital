import { env } from "@my-better-t-app/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createWebSocketHandlers } from "./lib/ws";
import chunksRoutes from "./routes/chunks";
import recordingsRoutes from "./routes/recordings";
import sessionsRoutes from "./routes/sessions";
import transcriptionsRoutes from "./routes/transcriptions";

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

app.route("/api/sessions", sessionsRoutes);
app.route("/api/recordings", recordingsRoutes);
app.route("/api/chunks", chunksRoutes);
app.route("/api/transcriptions", transcriptionsRoutes);

// Bun server with WebSocket support
const wsHandlers = createWebSocketHandlers();
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade: /ws?sessionId=xxx&participantId=yyy
    if (url.pathname === "/ws") {
      const sessionId = url.searchParams.get("sessionId");
      const participantId = url.searchParams.get("participantId");
      if (!sessionId || !participantId) {
        return new Response("Missing sessionId or participantId", { status: 400 });
      }
      const upgraded = server.upgrade(req, { data: { sessionId, participantId } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Regular HTTP requests handled by Hono
    return app.fetch(req, { ip: server.requestIP(req) });
  },
  websocket: wsHandlers,
});

console.log(`Server running on http://localhost:${server.port}`);
