export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export type MachineState = "IDLE" | "RUNNING" | "WARNING" | "ERROR" | "OFFLINE";

export interface Alert {
  id: string;
  severity: AlertSeverity;
  message: string;
  timestamp: string;
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
