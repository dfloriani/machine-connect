import { useQuery } from "@apollo/client";
import { useMemo } from "react";
import { GET_TELEMETRY } from "../graphql/operations";
import { toChartPoints, TelemetryPoint } from "../lib/telemetry";

interface UseTelemetryOptions {
  machineId: string;
  limit?: number;
  /**
   * Historical points only change when new readings land, so polling on a
   * slow interval is enough here. Live status uses the subscription instead.
   */
  pollInterval?: number;
}

export function useTelemetry({
  machineId,
  limit = 50,
  pollInterval = 10_000,
}: UseTelemetryOptions) {
  const { data, loading, error } = useQuery(GET_TELEMETRY, {
    variables: { machineId, limit },
    pollInterval,
    skip: !machineId,
  });

  const chartData: TelemetryPoint[] = useMemo(
    () => toChartPoints(data?.recentTelemetry ?? []),
    [data]
  );

  return { chartData, loading, error };
}
