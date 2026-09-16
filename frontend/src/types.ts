export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export type AlertKind = "ENTERED_WARNING" | "TEMPORARY_ANOMALY";

export type MachineState = "IDLE" | "RUNNING" | "WARNING" | "ERROR" | "OFFLINE";

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** Machine time of the reading that raised the alert, or of the first hot reading of a TEMPORARY_ANOMALY. */
  timestamp: string;
  /** TEMPORARY_ANOMALY only: machine time of the last hot reading. */
  lastHotAt: string | null;
  /** TEMPORARY_ANOMALY only: machine time of the first stored reading after the period that is not hot. */
  laterReadingAt: string | null;
  /** TEMPORARY_ANOMALY only: the highest temperature and rpm of the period. */
  readings: { key: string; value: string }[] | null;
  acknowledged: boolean;
}

export interface Machine {
  id: string;
  name: string;
  status: MachineState;
  temperature: number | null;
  rpm: number | null;
  lastSeen: string;
  alerts: Alert[];
}

/** An alert plus the machine it belongs to, for the dashboard-wide banner. */
export interface AlertWithMachine extends Alert {
  machineId: string;
  machineName: string;
}
