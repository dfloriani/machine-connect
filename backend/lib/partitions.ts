/**
 * Telemetry is partitioned one table per UTC day, which lets retention drop a
 * whole partition instead of deleting millions of rows and leaving the table
 * for vacuum to clean up.
 *
 * The naming and date maths live here so they can be tested without a
 * database. Partition names are derived from their day, so the day a partition
 * covers can always be recovered from its name.
 */

export const PARTITION_PREFIX = "telemetry_";

export interface PartitionSpec {
  /** Table name, for example telemetry_2026_08_13. */
  name: string;
  /** Inclusive lower bound, as an ISO date. */
  from: string;
  /** Exclusive upper bound, as an ISO date. */
  to: string;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function partitionName(date: Date): string {
  return PARTITION_PREFIX + toIsoDate(date).replaceAll("-", "_");
}

/** Parses the day back out of a partition name, or null if it is not one. */
export function partitionDate(name: string): Date | null {
  if (!name.startsWith(PARTITION_PREFIX)) return null;

  const [year, month, day] = name.slice(PARTITION_PREFIX.length).split("_");
  if (!year || !month || !day) return null;

  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  return isNaN(date.getTime()) ? null : date;
}

export function partitionSpec(date: Date): PartitionSpec {
  const from = startOfUtcDay(date);
  return {
    name: partitionName(from),
    from: toIsoDate(from),
    to: toIsoDate(addDays(from, 1)),
  };
}

/** The start of the oldest UTC day that retention keeps. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return addDays(startOfUtcDay(now), -retentionDays);
}

/**
 * Every day from the retention cutoff to a few days ahead. Partitions follow
 * the machine's time, so a late reading needs the partition of a past day,
 * which does not exist on a new database or after the server was stopped.
 */
export function partitionsToCreate(
  now: Date,
  retentionDays: number,
  daysAhead: number
): PartitionSpec[] {
  const cutoff = retentionCutoff(now, retentionDays);
  return Array.from({ length: retentionDays + daysAhead + 1 }, (_, offset) =>
    partitionSpec(addDays(cutoff, offset))
  );
}

/**
 * True when a reading's time has a partition. The upper bound is one day
 * less than partitionsToCreate covers: maintenance runs every few hours, so
 * when a new UTC day starts, the newest partition can still be missing until
 * the next run.
 */
export function isInPartitionRange(
  recordedAt: Date,
  now: Date,
  retentionDays: number,
  daysAhead: number
): boolean {
  const from = retentionCutoff(now, retentionDays);
  const to = addDays(startOfUtcDay(now), daysAhead);
  return recordedAt.getTime() >= from.getTime() && recordedAt.getTime() < to.getTime();
}

/**
 * Partitions whose day falls entirely outside the retention window. Because
 * partitions are dropped a day at a time, up to one extra day is kept.
 */
export function expiredPartitions(
  names: string[],
  now: Date,
  retentionDays: number
): string[] {
  const cutoff = retentionCutoff(now, retentionDays);

  return names.filter((name) => {
    const day = partitionDate(name);
    return day !== null && day.getTime() < cutoff.getTime();
  });
}
