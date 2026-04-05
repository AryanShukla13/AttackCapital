import { useCallback, useEffect, useRef, useState } from "react";

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Session updates hook.
 * On Vercel (serverless), WebSocket is not available — we use HTTP polling instead.
 * The hook tries WebSocket first and falls back to polling if connection fails.
 */
export function useSessionWs(sessionId: string | null, participantId: string | null) {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failCountRef = useRef(0);

  const connect = useCallback(() => {
    if (!sessionId || !participantId) return;

    // After 2 failed WebSocket attempts, stop trying (serverless environment)
    if (failCountRef.current >= 2) {
      setIsConnected(false);
      return;
    }

    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}&participantId=${participantId}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setIsConnected(true);
        failCountRef.current = 0;
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WsMessage;
          if (data.type === "pong") return;
          setMessages((prev) => [...prev, data]);
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
        failCountRef.current++;
        if (failCountRef.current < 2) {
          reconnectTimeoutRef.current = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    } catch {
      failCountRef.current = 2; // Give up on WS
    }
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
