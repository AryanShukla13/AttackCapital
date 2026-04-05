/**
 * WebSocket manager for real-time session updates.
 * In serverless (Vercel), WebSocket is unavailable — broadcasts are no-ops
 * and clients fall back to HTTP polling (already implemented).
 * In Bun (local dev / Cloud Run), full WebSocket support works.
 */

interface WsLike {
  send(data: string): void;
  data: { sessionId: string; participantId: string };
}

// Session ID -> Set of WebSocket connections
const sessionConnections = new Map<string, Set<WsLike>>();

export function addConnection(sessionId: string, ws: WsLike): void {
  let connections = sessionConnections.get(sessionId);
  if (!connections) {
    connections = new Set();
    sessionConnections.set(sessionId, connections);
  }
  connections.add(ws);
}

export function removeConnection(sessionId: string, ws: WsLike): void {
  const connections = sessionConnections.get(sessionId);
  if (connections) {
    connections.delete(ws);
    if (connections.size === 0) {
      sessionConnections.delete(sessionId);
    }
  }
}

export function broadcastToSession(sessionId: string, message: Record<string, unknown>): void {
  const connections = sessionConnections.get(sessionId);
  if (!connections) return;

  const data = JSON.stringify(message);
  for (const ws of connections) {
    try {
      ws.send(data);
    } catch {
      connections.delete(ws);
    }
  }
}

export function getSessionConnectionCount(sessionId: string): number {
  return sessionConnections.get(sessionId)?.size ?? 0;
}

/**
 * Set up WebSocket upgrade handler for Bun's native server.
 * Only used in Bun runtime (local dev / Cloud Run).
 */
export function createWebSocketHandlers() {
  return {
    message(ws: WsLike, message: string | Buffer) {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        // Ignore malformed messages
      }
    },
    open(ws: WsLike) {
      const { sessionId } = ws.data;
      addConnection(sessionId, ws);
      broadcastToSession(sessionId, {
        type: "participant_connected",
        participantId: ws.data.participantId,
      });
    },
    close(ws: WsLike) {
      const { sessionId } = ws.data;
      removeConnection(sessionId, ws);
      broadcastToSession(sessionId, {
        type: "participant_disconnected",
        participantId: ws.data.participantId,
      });
    },
  };
}
