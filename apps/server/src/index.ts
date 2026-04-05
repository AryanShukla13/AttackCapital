import { createWebSocketHandlers } from "./lib/ws";
import app from "./app";

// Bun server with WebSocket support (used for local dev)
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

    return app.fetch(req, { ip: server.requestIP(req) });
  },
  websocket: wsHandlers,
});

console.log(`Server running on http://localhost:${server.port}`);
