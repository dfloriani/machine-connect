/**
 * Pure subscription helpers, kept out of server.ts so they can be unit tested
 * without a database or a broker running.
 */

/**
 * Tells if a subscriber receives an event for one machine. A subscriber with
 * no machineId receives the events for all machines.
 */
export function isMachineSubscribed(
  eventMachineId: string,
  requestedMachineId?: string | null
): boolean {
  return !requestedMachineId || eventMachineId === requestedMachineId;
}
