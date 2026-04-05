/**
 * WebSocket manager for real-time session updates.
 * Each session has a set of connected WebSocket clients.
 * Broadcasts transcription results and chunk events to all participants in a session.
 */

import type { ServerWebSocket } from "bun";

interface WsData {
  sessionId: string;
  participantId: string;
}

// Session ID -> Set of WebSocket connections
const sessionConnections = new Map<string, Set<ServerWebSocket<WsData>>>();

export function addConnection(sessionId: string, ws: ServerWebSocket<WsData>): void {
  let connections = sessionConnections.get(sessionId);
  if (!connections) {
    connections = new Set();
    sessionConnections.set(sessionId, connections);
  }
  connections.add(ws);
}

export function removeConnection(sessionId: string, ws: ServerWebSocket<WsData>): void {
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
 * Call this from the server entry point.
 */
export function createWebSocketHandlers() {
  return {
    message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
      // Handle ping/pong for keep-alive
      try {
        const data = JSON.parse(message.toString());
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        // Ignore malformed messages
      }
    },
    open(ws: ServerWebSocket<WsData>) {
      const { sessionId } = ws.data;
      addConnection(sessionId, ws);
      broadcastToSession(sessionId, {
        type: "participant_connected",
        participantId: ws.data.participantId,
      });
    },
    close(ws: ServerWebSocket<WsData>) {
      const { sessionId } = ws.data;
      removeConnection(sessionId, ws);
      broadcastToSession(sessionId, {
        type: "participant_disconnected",
        participantId: ws.data.participantId,
      });
    },
  };
}
