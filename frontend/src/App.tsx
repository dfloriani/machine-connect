import { useEffect, useState } from "react";
import { useQuery } from "@apollo/client";
import { MachineList } from "./components/MachineList";
import { TelemetryChart } from "./components/TelemetryChart";
import { AlertBanner } from "./components/AlertBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { GET_MACHINES, MACHINE_UPDATED } from "./graphql/operations";
import type { Machine } from "./types";

const PAGE_SIZE = 10;

export default function App() {
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  /**
   * One query for the whole dashboard. My first version had each card fetch
   * its own machine, which meant N queries and N subscriptions for a list the
   * server had already sent in full.
   */
  const { data, loading, error, subscribeToMore } = useQuery<{
    machines: { nodes: Machine[]; totalCount: number; hasNextPage: boolean };
  }>(GET_MACHINES, {
    variables: { limit: PAGE_SIZE, offset },
  });

  /**
   * A single subscription for every machine. The payload carries the machine
   * id, so Apollo writes it into the normalised cache entry and the matching
   * card re-renders on its own - updateQuery only has to leave the page
   * membership alone.
   */
  useEffect(
    () =>
      subscribeToMore({
        document: MACHINE_UPDATED,
        updateQuery: (prev) => prev,
      }),
    [subscribeToMore]
  );

  const machines = data?.machines.nodes ?? [];

  const activeAlerts = machines.flatMap((machine) =>
    machine.alerts
      .filter((alert) => !alert.acknowledged)
      .map((alert) => ({
        ...alert,
        machineId: machine.id,
        machineName: machine.name,
      }))
  );

  return (
    <div className="app">
      <header className="app__header">
        <h1>Machine Connect</h1>
        <ConnectionStatus />
      </header>

      <AlertBanner alerts={activeAlerts} />

      <main className="app__main">
        <aside className="app__sidebar">
          <ErrorBoundary fallback={<p>Failed to load the machine list.</p>}>
            <MachineList
              machines={machines}
              totalCount={data?.machines.totalCount ?? 0}
              hasNextPage={data?.machines.hasNextPage ?? false}
              loading={loading}
              error={error}
              selectedId={selectedMachineId}
              onSelect={setSelectedMachineId}
              onPrevious={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              onNext={() => setOffset((o) => o + PAGE_SIZE)}
              canGoPrevious={offset > 0}
            />
          </ErrorBoundary>
        </aside>

        <section className="app__detail">
          {selectedMachineId ? (
            <ErrorBoundary fallback={<p>Failed to load the telemetry chart.</p>}>
              <TelemetryChart machineId={selectedMachineId} />
            </ErrorBoundary>
          ) : (
            <p className="app__empty">Select a machine to view its telemetry.</p>
          )}
        </section>
      </main>
    </div>
  );
}
