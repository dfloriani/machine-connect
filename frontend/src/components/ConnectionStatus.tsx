import { useEffect, useState } from "react";
import { WS_STATUS_EVENTS, WsStatus } from "../apolloClient";

const STATUS_LABELS: Record<WsStatus, string> = {
  connected: "Live",
  disconnected: "Reconnecting...",
  error: "Connection error",
};

const STATUS_COLORS: Record<WsStatus, string> = {
  connected: "#22c55e",
  disconnected: "#f59e0b",
  error: "#ef4444",
};

/**
 * The graphql-ws client lives outside React, so it reports its state through
 * window events and this component listens for them. A context provider would
 * be tidier if anything else ever needed the connection state.
 */
export function ConnectionStatus() {
  const [status, setStatus] = useState<WsStatus>("disconnected");

  useEffect(() => {
    const listeners = (Object.keys(WS_STATUS_EVENTS) as WsStatus[]).map((wsStatus) => {
      const handler = () => setStatus(wsStatus);
      window.addEventListener(WS_STATUS_EVENTS[wsStatus], handler);
      return () => window.removeEventListener(WS_STATUS_EVENTS[wsStatus], handler);
    });

    return () => listeners.forEach((removeListener) => removeListener());
  }, []);

  return (
    <div
      className="connection-status"
      title={`WebSocket: ${status}`}
      style={{ color: STATUS_COLORS[status] }}
    >
      <span
        className="connection-status__dot"
        style={{ backgroundColor: STATUS_COLORS[status] }}
      />
      {STATUS_LABELS[status]}
    </div>
  );
}
