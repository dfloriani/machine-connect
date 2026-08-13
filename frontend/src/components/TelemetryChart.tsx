import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useTelemetry } from "../hooks/useTelemetry";

const formatTime = (ts: string) =>
  new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export function TelemetryChart({ machineId }: { machineId: string }) {
  const { chartData, loading, error } = useTelemetry({ machineId, limit: 50 });

  if (loading && chartData.length === 0) return <p>Loading telemetry...</p>;
  if (error) return <p>Error loading telemetry: {error.message}</p>;
  if (chartData.length === 0) return <p>No telemetry recorded for this machine yet.</p>;

  return (
    <div className="telemetry-chart">
      <h2>Telemetry for {machineId}</h2>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="timestamp" tickFormatter={formatTime} minTickGap={40} />
          {/* Temperature and RPM differ by orders of magnitude, so they get
              their own axes rather than one flat line and one spiky one. */}
          <YAxis yAxisId="temp" unit="°C" domain={["auto", "auto"]} />
          <YAxis
            yAxisId="rpm"
            orientation="right"
            unit=" rpm"
            domain={["auto", "auto"]}
          />
          <Tooltip labelFormatter={formatTime} />
          <Legend />
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="temperature"
            stroke="#f59e0b"
            dot={false}
            name="Temperature (°C)"
          />
          <Line
            yAxisId="rpm"
            type="monotone"
            dataKey="rpm"
            stroke="#3b82f6"
            dot={false}
            name="RPM"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
