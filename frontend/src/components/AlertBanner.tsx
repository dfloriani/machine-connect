import { useMutation } from "@apollo/client";
import { ACKNOWLEDGE_ALERT } from "../graphql/operations";
import { alertText } from "../lib/alerts";
import type { AlertSeverity, AlertWithMachine } from "../types";

const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  INFO: "#3b82f6",
  WARNING: "#f59e0b",
  CRITICAL: "#ef4444",
};

export function AlertBanner({ alerts }: { alerts: AlertWithMachine[] }) {
  const [acknowledgeAlert] = useMutation(ACKNOWLEDGE_ALERT);

  if (alerts.length === 0) return null;

  return (
    <div className="alert-banner" role="status" aria-live="polite">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className="alert-banner__item"
          style={{ backgroundColor: SEVERITY_COLORS[alert.severity] }}
        >
          <span className="alert-banner__label">{alert.severity}</span>
          <span className="alert-banner__machine">{alert.machineName}</span>
          <span className="alert-banner__message">{alertText(alert)}</span>
          <button
            className="alert-banner__ack"
            onClick={() =>
              acknowledgeAlert({
                variables: { machineId: alert.machineId, alertId: alert.id },
                optimisticResponse: {
                  acknowledgeAlert: {
                    __typename: "Alert",
                    id: alert.id,
                    kind: alert.kind,
                    severity: alert.severity,
                    timestamp: alert.timestamp,
                    lastHotAt: alert.lastHotAt,
                    laterReadingAt: alert.laterReadingAt,
                    readings: alert.readings,
                    acknowledged: true,
                  },
                },
              })
            }
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
