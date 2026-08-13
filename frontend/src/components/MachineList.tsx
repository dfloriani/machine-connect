import { ApolloError } from "@apollo/client";
import { MachineCard } from "./MachineCard";
import type { Machine } from "../types";

interface MachineListProps {
  machines: Machine[];
  totalCount: number;
  hasNextPage: boolean;
  loading: boolean;
  error?: ApolloError;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  canGoPrevious: boolean;
}

// Presentational on purpose: App owns the query so the list, the cards and the
// alert banner all read from the same result.
export function MachineList({
  machines,
  totalCount,
  hasNextPage,
  loading,
  error,
  selectedId,
  onSelect,
  onPrevious,
  onNext,
  canGoPrevious,
}: MachineListProps) {
  if (error) return <p className="machine-list__error">{error.message}</p>;
  if (loading && machines.length === 0) return <p>Loading machines...</p>;

  return (
    <div className="machine-list-container">
      <p className="machine-list__count">
        Showing {machines.length} of {totalCount} machines
      </p>

      <ul className="machine-list" data-loading={loading}>
        {machines.map((machine) => (
          <li key={machine.id} className="machine-list__item">
            <MachineCard
              machine={machine}
              selected={selectedId === machine.id}
              onSelect={onSelect}
            />
          </li>
        ))}
      </ul>

      <div className="machine-list__pagination">
        <button onClick={onPrevious} disabled={!canGoPrevious || loading}>
          Previous
        </button>
        <button onClick={onNext} disabled={!hasNextPage || loading}>
          Next
        </button>
      </div>
    </div>
  );
}
