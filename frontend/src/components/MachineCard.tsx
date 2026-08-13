import { memo } from "react";
import { useMutation } from "@apollo/client";
import { ACKNOWLEDGE_ALERT } from "../graphql/operations";
import type { Alert, Machine, MachineState } from "../types";

const STATUS_COLORS: Record<MachineState, string> = {
  IDLE: "#64748b",
  RUNNING: "#22c55e",
  WARNING: "#f59e0b",
  ERROR: "#ef4444",
  OFFLINE: "#374151",
};

const WARN_ABOVE = { temperature: 80, rpm: 4500 };

interface MachineCardProps {
  machine: Machine;
  selected: boolean;
  onSelect: (id: string) => void;
}

function Metric({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className={`metric ${warn ? "metric--warn" : ""}`}>
      <span className="metric__label">{label}</span>
      <span className="metric__value">{value}</span>
    </div>
  );
}

function AlertRow({
  alert,
  onAcknowledge,
}: {
  alert: Alert;
  onAcknowledge: (alert: Alert) => void;
}) {
  return (
    <li className={`alert alert--${alert.severity.toLowerCase()}`}>
      <span>{alert.message}</span>
      <button
        onClick={(event) => {
          // The whole card is clickable, so stop the click selecting it too.
          event.stopPropagation();
          onAcknowledge(alert);
        }}
      >
        Acknowledge
      </button>
    </li>
  );
}

// memo pays off here because a subscription event re-renders the list on every
// incoming reading, while most cards in it have not changed.
export const MachineCard = memo(function MachineCard({
  machine,
  selected,
  onSelect,
}: MachineCardProps) {
  const [acknowledgeAlert] = useMutation(ACKNOWLEDGE_ALERT);

  const unacknowledged = machine.alerts.filter((alert) => !alert.acknowledged);

  /**
   * Acknowledging is a local decision that the server will almost always
   * confirm, so the optimistic response flips the flag right away. It echoes
   * the alert I already have rather than inventing values, otherwise the
   * normalised cache entry would briefly lose its message and severity.
   */
  const handleAcknowledge = (alert: Alert) =>
    acknowledgeAlert({
      variables: { machineId: machine.id, alertId: alert.id },
      optimisticResponse: {
        acknowledgeAlert: { __typename: "Alert", ...alert, acknowledged: true },
      },
    });

  return (
    <article
      className={`machine-card ${selected ? "machine-card--selected" : ""}`}
      onClick={() => onSelect(machine.id)}
    >
      <header className="machine-card__header">
        <h2 className="machine-card__name">{machine.name}</h2>
        <span
          className="machine-card__status-badge"
          style={{ backgroundColor: STATUS_COLORS[machine.status] }}
        >
          {machine.status}
        </span>
      </header>

      <div className="machine-card__metrics">
        <Metric
          label="Temperature"
          value={machine.temperature != null ? `${machine.temperature}°C` : "-"}
          warn={
            machine.temperature != null && machine.temperature > WARN_ABOVE.temperature
          }
        />
        <Metric
          label="RPM"
          value={machine.rpm != null ? machine.rpm.toLocaleString() : "-"}
          warn={machine.rpm != null && machine.rpm > WARN_ABOVE.rpm}
        />
        <Metric
          label="Last seen"
          value={new Date(machine.lastSeen).toLocaleTimeString()}
        />
      </div>

      {unacknowledged.length > 0 && (
        <section className="machine-card__alerts">
          <h3>Active alerts</h3>
          <ul>
            {unacknowledged.map((alert) => (
              <AlertRow key={alert.id} alert={alert} onAcknowledge={handleAcknowledge} />
            ))}
          </ul>
        </section>
      )}
    </article>
  );
});
