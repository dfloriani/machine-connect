import { gql } from "@apollo/client";

/**
 * Every document lives here so the fragments below stay the single definition
 * of "what a machine looks like to this client". Queries and subscriptions
 * requesting the same fields is what lets the normalised cache update a card
 * from a subscription payload without a refetch.
 */

export const ALERT_FRAGMENT = gql`
  fragment AlertFields on Alert {
    id
    severity
    message
    timestamp
    acknowledged
  }
`;

export const MACHINE_FRAGMENT = gql`
  fragment MachineFields on MachineStatus {
    id
    name
    status
    temperature
    rpm
    lastSeen
    alerts {
      ...AlertFields
    }
  }
  ${ALERT_FRAGMENT}
`;

export const GET_MACHINES = gql`
  query GetMachines($limit: Int, $offset: Int) {
    machines(limit: $limit, offset: $offset) {
      nodes {
        ...MachineFields
      }
      totalCount
      hasNextPage
    }
  }
  ${MACHINE_FRAGMENT}
`;

export const GET_TELEMETRY = gql`
  query GetTelemetry($machineId: ID!, $limit: Int) {
    recentTelemetry(machineId: $machineId, limit: $limit) {
      machineId
      timestamp
      values {
        key
        value
      }
    }
  }
`;

export const ACKNOWLEDGE_ALERT = gql`
  mutation AcknowledgeAlert($machineId: ID!, $alertId: ID!) {
    acknowledgeAlert(machineId: $machineId, alertId: $alertId) {
      ...AlertFields
    }
  }
  ${ALERT_FRAGMENT}
`;

// No machineId argument: the dashboard subscribes once and lets the cache
// route each payload to the right machine.
export const MACHINE_UPDATED = gql`
  subscription MachineUpdated {
    machineUpdated {
      ...MachineFields
    }
  }
  ${MACHINE_FRAGMENT}
`;
