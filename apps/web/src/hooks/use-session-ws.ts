import { useCallback, useEffect, useRef, useState } from "react";
import { env } from "@my-better-t-app/env/web";

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * WebSocket hook for real-time session updates.
 * Auto-reconnects on disconnect.
 */
export function useSessionWs(sessionId: string | null, participantId: string | null) {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connect = useCallback(() => {
    if (!sessionId || !participantId) return;

    const wsUrl = env.NEXT_PUBLIC_SERVER_URL.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsUrl}/ws?sessionId=${sessionId}&participantId=${participantId}`);

    ws.onopen = () => {
      setIsConnected(true);
      // Ping every 30s to keep alive
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsMessage;
        if (data.type === "pong") return; // ignore pong
        setMessages((prev) => [...prev, data]);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      // Auto-reconnect after 2s
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [sessionId, participantId]);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    };
  }, [connect]);

  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, isConnected, clearMessages };
}
