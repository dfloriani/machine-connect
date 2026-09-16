import express, { type Request, type Response } from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { PubSub, withFilter } from "graphql-subscriptions";
import { createServer } from "http";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";
import cors from "cors";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import depthLimit from "graphql-depth-limit";
import pg from "pg";
import amqplib from "amqplib";
import pino from "pino";

import {
  validateTelemetryValues,
  toKeyValueMap,
  deriveStatus,
  shouldRaiseAlert,
  parseRecordedAt,
  shouldApplyReading,
  isClockAhead,
  isTemporaryAnomaly,
  temporaryAnomalyAction,
  peakReadings,
  isPeakRaised,
  type KeyValue,
  type Neighbour,
  type MachineState,
} from "./lib/telemetry.js";
import {
  partitionsToCreate,
  isInPartitionRange,
  expiredPartitions,
  retentionCutoff,
} from "./lib/partitions.js";
import { isMachineSubscribed } from "./lib/subscriptions.js";

interface AuthUser {
  userId: string;
  role: string;
}

interface GraphQLContext {
  user: AuthUser | null;
}

/**
 * What an alert is about. The API sends the kind and the times, and the
 * dashboard builds the text, so every time is shown in the viewer's time zone.
 */
type AlertKind = "ENTERED_WARNING" | "TEMPORARY_ANOMALY";

/** Shapes the API returns, with timestamps already serialised. */
interface Alert {
  id: string;
  kind: AlertKind;
  severity: "INFO" | "WARNING" | "CRITICAL";
  timestamp: string;
  lastHotAt: string | null;
  laterReadingAt: string | null;
  readings: KeyValue[] | null;
  acknowledged: boolean;
}

interface Machine {
  id: string;
  name: string;
  status: MachineState;
  temperature: number | null;
  rpm: number | null;
  lastSeen: string;
  alerts: Alert[];
}

/**
 * Rows as the driver hands them back. Timestamps are Date objects when they
 * come from a column and strings when they arrive inside json_agg output.
 */
interface AlertRow {
  id: string;
  kind: AlertKind;
  severity: Alert["severity"];
  timestamp: Date | string;
  last_hot_at: Date | string | null;
  later_reading_at: Date | string | null;
  readings: KeyValue[] | null;
  acknowledged: boolean;
}

interface MachineRow {
  id: string;
  name: string;
  status: MachineState;
  temperature: number | null;
  rpm: number | null;
  last_seen: Date;
  alerts: AlertRow[] | null;
}

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production" ? { target: "pino-pretty" } : undefined,
});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/**
 * No migration tool on a project this size: the schema is created on boot and
 * seeded with a few machines so the dashboard has something to show.
 */
async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'IDLE',
      temperature FLOAT,
      rpm INT,
      -- Server time of the last reading received, whether it was applied or not.
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Machine time of the newest reading applied to this row.
      last_recorded_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES machines(id),
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      -- Machine time of the reading that raised the alert, or of the first hot
      -- reading of a temporary anomaly.
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- TEMPORARY_ANOMALY only: machine time of the last hot reading.
      last_hot_at TIMESTAMPTZ,
      -- TEMPORARY_ANOMALY only: machine time of the first stored reading after
      -- last_hot_at that is not hot.
      later_reading_at TIMESTAMPTZ,
      -- TEMPORARY_ANOMALY only: the highest temperature and rpm of the period.
      readings JSONB,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      -- No two alerts start at the same reading, so a reading that is
      -- processed twice cannot write a second row.
      UNIQUE (machine_id, timestamp)
    );

    -- recorded_at comes from the machine's clock, received_at from the server's.
    -- Partitions follow recorded_at, so a unique key on (machine_id, recorded_at)
    -- is allowed and a reading that arrives twice is stored once. A reading
    -- whose recorded_at has no partition goes to out_of_range_readings.
    -- The unique key's index also serves the newest-first query per machine.
    CREATE TABLE IF NOT EXISTS telemetry (
      id BIGINT GENERATED ALWAYS AS IDENTITY,
      machine_id TEXT NOT NULL REFERENCES machines(id),
      recorded_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      -- deriveStatus() at insert time, so neighbour queries can find hot readings.
      status TEXT NOT NULL,
      values JSONB NOT NULL,
      PRIMARY KEY (id, recorded_at),
      UNIQUE (machine_id, recorded_at)
    ) PARTITION BY RANGE (recorded_at);

    -- Readings from a machine clock too far in the past or the future. They
    -- are kept so the clock error can be measured, and the chart does not
    -- read them. Retention deletes them by received_at.
    CREATE TABLE IF NOT EXISTS out_of_range_readings (
      machine_id TEXT NOT NULL REFERENCES machines(id),
      recorded_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      values JSONB NOT NULL,
      PRIMARY KEY (machine_id, recorded_at)
    );

    CREATE INDEX IF NOT EXISTS out_of_range_readings_received_at_idx
      ON out_of_range_readings (received_at);
  `);

  await runTelemetryMaintenance();

  const { rowCount } = await pool.query("SELECT 1 FROM machines LIMIT 1");
  if (rowCount === 0) {
    for (const id of ["M-001", "M-002", "M-003"]) {
      await pool.query(
        "INSERT INTO machines (id, name, status, temperature, rpm) VALUES ($1, $2, $3, $4, $5)",
        [id, `CNC Machine ${id}`, "IDLE", 22.5, 0]
      );
    }
    logger.info("Seeded initial machines");
  }
}

/**
 * Raw readings are kept for this many days and then dropped a whole partition
 * at a time. Anything longer term would want downsampled rollups rather than
 * every reading, which this project does not do yet.
 */
const RETENTION_DAYS = parseInt(process.env.TELEMETRY_RETENTION_DAYS ?? "30", 10);
const PARTITION_DAYS_AHEAD = 3;
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * A database created before telemetry was partitioned still has a plain table,
 * and there is no migration tool here to convert it. Retention is skipped
 * rather than crashing the server on boot.
 */
async function isTelemetryPartitioned(): Promise<boolean> {
  const { rows } = await pool.query<{ relkind: string }>(
    "SELECT relkind FROM pg_class WHERE relname = 'telemetry'"
  );
  return rows[0]?.relkind === "p";
}

/**
 * Creates the partitions from the retention cutoff to a few days ahead, drops
 * expired ones, and deletes expired out-of-range readings.
 */
async function runTelemetryMaintenance(now = new Date()): Promise<void> {
  // A small table without partitions, so a DELETE is enough here.
  await pool.query("DELETE FROM out_of_range_readings WHERE received_at < $1", [
    retentionCutoff(now, RETENTION_DAYS),
  ]);

  if (!(await isTelemetryPartitioned())) {
    logger.warn(
      "telemetry is not partitioned, so retention is disabled. Recreate the database volume to enable it."
    );
    return;
  }

  for (const { name, from, to } of partitionsToCreate(
    now,
    RETENTION_DAYS,
    PARTITION_DAYS_AHEAD
  )) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${name}
       PARTITION OF telemetry FOR VALUES FROM ('${from}') TO ('${to}')`
    );
  }

  const { rows } = await pool.query<{ name: string }>(
    `SELECT c.relname AS name
     FROM pg_class c
     JOIN pg_inherits i ON i.inhrelid = c.oid
     JOIN pg_class parent ON parent.oid = i.inhparent
     WHERE parent.relname = 'telemetry'`
  );

  const expired = expiredPartitions(
    rows.map((r) => r.name),
    now,
    RETENTION_DAYS
  );

  for (const name of expired) {
    await pool.query(`DROP TABLE IF EXISTS ${name}`);
  }

  if (expired.length > 0) {
    logger.info(
      { dropped: expired, retentionDays: RETENTION_DAYS },
      "Dropped expired telemetry partitions"
    );
  }
}

let rabbitChannel: amqplib.Channel | null = null;
const TELEMETRY_QUEUE = "telemetry";

/**
 * How many unacknowledged readings the consumer holds at one time. It stays
 * below the pool size (10 by default): each reading holds a pooled connection,
 * also while it waits for its machine's row lock, and GraphQL queries need
 * connections too.
 */
const CONSUMER_PREFETCH = 5;

/**
 * Machines push readings far faster than the database wants to be written to,
 * so the HTTP endpoint only enqueues and this consumer does the real work.
 */
async function initRabbit(): Promise<void> {
  const conn = await amqplib.connect(process.env.RABBITMQ_URL as string);
  const channel = await conn.createChannel();
  await channel.assertQueue(TELEMETRY_QUEUE, { durable: true });
  await channel.prefetch(CONSUMER_PREFETCH);

  await channel.consume(TELEMETRY_QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const { machineId, recordedAt, receivedAt, values } = JSON.parse(
        msg.content.toString()
      );
      await processTelemetry(machineId, recordedAt, new Date(receivedAt), values);
      channel.ack(msg);
    } catch (err) {
      logger.error({ err }, "Failed to process telemetry message");
      // Dropped rather than requeued: a malformed payload would loop forever.
      channel.nack(msg, false, false);
    }
  });

  rabbitChannel = channel;
  logger.info("RabbitMQ consumer ready");
}

/**
 * Auth is deliberately a stub for local development. A real deployment would
 * drop DEV_TOKEN and issue signed tokens from an identity provider.
 */
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-in-production";
const DEV_TOKEN = "dev-token-machine-connect";

function verifyToken(authHeader: string | undefined | null): AuthUser | null {
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  if (token === DEV_TOKEN) return { userId: "dev-user", role: "admin" };
  try {
    return jwt.verify(token, JWT_SECRET) as AuthUser;
  } catch {
    return null;
  }
}

function requireAuth(context: GraphQLContext): void {
  if (!context.user) {
    throw new Error(
      "Unauthorized - provide Authorization: Bearer dev-token-machine-connect"
    );
  }
}

// In-process pub/sub. Running more than one backend instance would need a
// Redis-backed implementation so events reach subscribers on every node.
const pubsub = new PubSub();
const MACHINE_EVENT = "MACHINE_EVENT";

/**
 * Timestamps are exposed as ISO strings. Handing a Date to a GraphQL String
 * field coerces it through valueOf(), which yields epoch milliseconds that
 * `new Date(...)` cannot parse back on the client.
 */
function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function dbRowToAlert(row: AlertRow): Alert {
  const optionalIso = (value: Date | string | null) =>
    value === null ? null : toIsoString(value);
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    timestamp: toIsoString(row.timestamp),
    lastHotAt: optionalIso(row.last_hot_at),
    laterReadingAt: optionalIso(row.later_reading_at),
    readings: row.readings,
    acknowledged: row.acknowledged,
  };
}

function dbRowToMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    temperature: row.temperature,
    rpm: row.rpm,
    lastSeen: toIsoString(row.last_seen),
    alerts: (row.alerts ?? []).map(dbRowToAlert),
  };
}

// Alerts come back in the same round trip as the machine row. Resolving them
// in a field resolver instead would mean one extra query per machine.
const MACHINE_SELECT = `
  SELECT m.id, m.name, m.status, m.temperature, m.rpm, m.last_seen,
    COALESCE(
      json_agg(a ORDER BY a.timestamp DESC) FILTER (WHERE a.id IS NOT NULL),
      '[]'
    ) AS alerts
  FROM machines m
  LEFT JOIN alerts a ON a.machine_id = m.id
`;

async function getMachine(id: string): Promise<Machine | null> {
  const { rows } = await pool.query<MachineRow>(
    `${MACHINE_SELECT} WHERE m.id = $1 GROUP BY m.id`,
    [id]
  );
  const row = rows[0];
  return row ? dbRowToMachine(row) : null;
}

interface StoredNeighbour extends Neighbour {
  recordedAt: Date;
}

/**
 * The stored reading of a machine just before or just after a time, and the
 * TEMPORARY_ANOMALY alert whose period covers it.
 */
async function findNeighbour(
  client: pg.PoolClient,
  machineId: string,
  recordedAt: Date,
  direction: "before" | "after"
): Promise<StoredNeighbour | null> {
  const [compare, order] = direction === "before" ? ["<", "DESC"] : [">", "ASC"];
  const { rows } = await client.query<{
    recorded_at: Date;
    status: MachineState;
    alert_id: string | null;
  }>(
    `SELECT t.recorded_at, t.status, a.id AS alert_id
     FROM (
       SELECT recorded_at, status FROM telemetry
       WHERE machine_id = $1 AND recorded_at ${compare} $2
       ORDER BY recorded_at ${order}
       LIMIT 1
     ) t
     LEFT JOIN alerts a
       ON a.machine_id = $1
      AND a.kind = 'TEMPORARY_ANOMALY'
      AND t.recorded_at BETWEEN a.timestamp AND a.last_hot_at`,
    [machineId, recordedAt]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    recordedAt: row.recorded_at,
    hot: row.status === "WARNING",
    alertId: row.alert_id,
  };
}

interface AnomalyRow {
  id: string;
  timestamp: Date;
  last_hot_at: Date;
  readings: KeyValue[];
}

/**
 * Adds a late hot reading to the temporary anomaly alert of its hot period, or
 * starts one (DECISIONS.md, entry 4). The machine row lock keeps the stored
 * readings next to it unchanged until this transaction ends.
 */
async function recordTemporaryAnomaly(
  client: pg.PoolClient,
  machineId: string,
  takenAt: Date,
  readings: KeyValue[]
): Promise<void> {
  const previous = await findNeighbour(client, machineId, takenAt, "before");
  const next = await findNeighbour(client, machineId, takenAt, "after");
  const action = temporaryAnomalyAction(previous, next);

  if (action.type === "none") return;

  if (action.type === "insert") {
    // A newer reading was applied, so a next neighbour is always stored.
    const laterReadingAt = (next as StoredNeighbour).recordedAt;
    const peaks = peakReadings([], readings);
    await client.query(
      `INSERT INTO alerts
         (id, machine_id, kind, severity, timestamp, last_hot_at, later_reading_at, readings)
       VALUES ($1, $2, 'TEMPORARY_ANOMALY', 'INFO', $3, $3, $4, $5)
       ON CONFLICT (machine_id, timestamp) DO NOTHING`,
      [
        `${machineId}-${randomUUID()}`,
        machineId,
        takenAt,
        laterReadingAt,
        JSON.stringify(peaks),
      ]
    );
    return;
  }

  if (action.type === "extendEnd" && action.otherAlertId) {
    logger.error(
      {
        machineId,
        recordedAt: takenAt,
        alertId: action.alertId,
        otherAlertId: action.otherAlertId,
      },
      "Late hot reading is next to two temporary anomaly alerts; extending the earlier one"
    );
  }

  const { rows } = await client.query<AnomalyRow>(
    "SELECT id, timestamp, last_hot_at, readings FROM alerts WHERE id = $1",
    [action.alertId]
  );
  const current = rows[0];
  if (!current) throw new Error(`Alert ${action.alertId} not found`);
  const startedAt = takenAt < current.timestamp ? takenAt : current.timestamp;
  const lastHotAt = takenAt > current.last_hot_at ? takenAt : current.last_hot_at;
  const peaks = peakReadings(current.readings, readings);

  // A period that only gets longer stays acknowledged. A higher peak is new
  // information, so the alert asks for attention again.
  await client.query(
    `UPDATE alerts
     SET timestamp = $2, last_hot_at = $3, readings = $4,
         acknowledged = acknowledged AND NOT $5
     WHERE id = $1`,
    [
      current.id,
      startedAt,
      lastHotAt,
      JSON.stringify(peaks),
      isPeakRaised(current.readings, peaks),
    ]
  );
}

/**
 * A late reading that is not hot, between a temporary anomaly's last hot
 * reading and its "over by" time, shows that the anomaly ended earlier.
 */
async function endTemporaryAnomalyEarlier(
  client: pg.PoolClient,
  machineId: string,
  takenAt: Date
): Promise<void> {
  await client.query(
    `UPDATE alerts SET later_reading_at = $2
     WHERE machine_id = $1 AND kind = 'TEMPORARY_ANOMALY'
       AND last_hot_at < $2 AND later_reading_at > $2`,
    [machineId, takenAt]
  );
}

/**
 * The single path every reading goes through, whether it arrived from the
 * queue or straight from the ingestTelemetry mutation.
 */
async function processTelemetry(
  machineId: string,
  recordedAt: unknown,
  receivedAt: Date,
  values: unknown
): Promise<Machine> {
  const readings: KeyValue[] = validateTelemetryValues(values);
  const takenAt = parseRecordedAt(recordedAt);
  if (isNaN(receivedAt.getTime())) throw new Error("receivedAt is not a valid time");

  const kv = toKeyValueMap(readings);
  const newStatus = deriveStatus(kv);
  const clockAhead = isClockAhead(takenAt, receivedAt);
  // Compared with the time of processing, not receivedAt: maintenance creates
  // partitions by the time it runs, and a reading can wait in the queue.
  const inRange = isInPartitionRange(
    takenAt,
    new Date(),
    RETENTION_DAYS,
    PARTITION_DAYS_AHEAD
  );
  let applied = false;
  let stored = false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // A second reading for this machine waits here until this transaction
    // ends, and then reads the status this one wrote.
    const { rows } = await client.query<{
      status: MachineState;
      last_recorded_at: Date | null;
    }>("SELECT status, last_recorded_at FROM machines WHERE id = $1 FOR UPDATE", [
      machineId,
    ]);
    const prev = rows[0];
    if (!prev) throw new Error(`Unknown machine ${machineId}`);

    // (machine_id, recorded_at) identifies a reading. A reading that is
    // already stored, for example a message RabbitMQ delivers again or a POST
    // the machine sends again, inserts nothing and changes nothing else.
    const { rowCount } = await client.query(
      `INSERT INTO ${inRange ? "telemetry" : "out_of_range_readings"}
         (machine_id, recorded_at, received_at, status, values)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (machine_id, recorded_at) DO NOTHING`,
      [machineId, takenAt, receivedAt, newStatus, JSON.stringify(readings)]
    );
    stored = rowCount === 1;

    if (stored) {
      applied = inRange && shouldApplyReading(prev.last_recorded_at, takenAt, receivedAt);

      if (applied) {
        await client.query(
          `UPDATE machines
           SET status=$1, temperature=COALESCE($2, temperature),
               rpm=COALESCE($3, rpm), last_recorded_at=$4,
               last_seen=GREATEST(last_seen, $5)
           WHERE id=$6`,
          [
            newStatus,
            kv.temperature ? parseFloat(kv.temperature) : null,
            kv.rpm ? parseInt(kv.rpm, 10) : null,
            takenAt,
            receivedAt,
            machineId,
          ]
        );
      } else {
        await client.query(
          "UPDATE machines SET last_seen=GREATEST(last_seen, $1) WHERE id=$2",
          [receivedAt, machineId]
        );
      }

      if (applied && shouldRaiseAlert(prev.status, newStatus)) {
        await client.query(
          `INSERT INTO alerts (id, machine_id, kind, severity, timestamp)
           VALUES ($1, $2, 'ENTERED_WARNING', 'WARNING', $3)
           ON CONFLICT (machine_id, timestamp) DO NOTHING`,
          [`${machineId}-${randomUUID()}`, machineId, takenAt]
        );
      } else if (
        // Not applied, inside the partition range and not from a clock that is
        // ahead: a newer reading was already applied, so this one describes
        // the past.
        !applied &&
        inRange &&
        !clockAhead &&
        prev.last_recorded_at !== null
      ) {
        if (isTemporaryAnomaly(newStatus, prev.status)) {
          await recordTemporaryAnomaly(client, machineId, takenAt, readings);
        } else if (newStatus !== "WARNING") {
          await endTemporaryAnomalyEarlier(client, machineId, takenAt);
        }
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (!stored) {
    logger.info({ machineId, recordedAt: takenAt }, "Reading already stored, ignored");
    return (await getMachine(machineId)) as Machine;
  }
  if (!inRange) {
    logger.warn(
      { machineId, recordedAt: takenAt, receivedAt },
      "Reading stored in out_of_range_readings: no telemetry partition covers its time"
    );
  }
  if (clockAhead) {
    logger.warn(
      { machineId, recordedAt: takenAt, receivedAt },
      "Reading not applied: the machine clock is ahead of the server clock"
    );
  }

  const updated = (await getMachine(machineId)) as Machine;
  await pubsub.publish(MACHINE_EVENT, { machineUpdated: updated });
  logger.info({ machineId, newStatus, applied }, "Telemetry processed");
  return updated;
}

const typeDefs = `#graphql
  type MachineStatus {
    id: ID!
    name: String!
    status: MachineState!
    temperature: Float
    rpm: Int
    lastSeen: String!
    alerts: [Alert!]!
  }

  enum MachineState {
    IDLE
    RUNNING
    WARNING
    ERROR
    OFFLINE
  }

  """
  An alert carries data, not text: the client builds the sentence from kind
  and the times, and formats the times in the viewer's time zone.
  """
  type Alert {
    id: ID!
    kind: AlertKind!
    severity: AlertSeverity!
    "Machine time of the reading that raised the alert, or of the first hot reading of a TEMPORARY_ANOMALY."
    timestamp: String!
    "TEMPORARY_ANOMALY only: machine time of the last hot reading."
    lastHotAt: String
    "TEMPORARY_ANOMALY only: machine time of the first stored reading after the period that is not hot."
    laterReadingAt: String
    "TEMPORARY_ANOMALY only: the highest temperature and rpm of the period."
    readings: [KeyValue!]
    acknowledged: Boolean!
  }

  enum AlertKind {
    "The machine's status changed into WARNING."
    ENTERED_WARNING
    "Hot readings that arrived after a newer reading that was not hot."
    TEMPORARY_ANOMALY
  }

  enum AlertSeverity {
    INFO
    WARNING
    CRITICAL
  }

  type TelemetryPayload {
    machineId: ID!
    "The time the machine took the reading, by the machine's clock."
    timestamp: String!
    values: [KeyValue!]!
  }

  type KeyValue {
    key: String!
    value: String!
  }

  """
  Offset pagination rather than Relay cursors: the machine list is small and
  ordered by a stable id, so cursors would be ceremony without a payoff.
  """
  type MachineConnection {
    nodes: [MachineStatus!]!
    totalCount: Int!
    hasNextPage: Boolean!
  }

  type Query {
    machines(limit: Int, offset: Int): MachineConnection!
    machine(id: ID!): MachineStatus
    recentTelemetry(machineId: ID!, limit: Int): [TelemetryPayload!]!
  }

  type Mutation {
    """
    recordedAt is the time the machine took the reading: ISO 8601 with a UTC
    offset, for example 2026-09-16T13:47:20.375Z.
    """
    ingestTelemetry(
      machineId: ID!
      recordedAt: String!
      values: [KeyValueInput!]!
    ): MachineStatus!
    acknowledgeAlert(machineId: ID!, alertId: ID!): Alert!
  }

  input KeyValueInput {
    key: String!
    value: String!
  }

  type Subscription {
    "Omit machineId to receive updates for every machine."
    machineUpdated(machineId: ID): MachineStatus!
  }
`;

const resolvers = {
  Query: {
    machines: async (
      _parent: unknown,
      { limit = 20, offset = 0 }: { limit?: number; offset?: number },
      context: GraphQLContext
    ) => {
      requireAuth(context);

      const { rows } = await pool.query<MachineRow>(
        `${MACHINE_SELECT} GROUP BY m.id ORDER BY m.id LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const { rows: countRows } = await pool.query<{ count: string }>(
        "SELECT COUNT(*) FROM machines"
      );
      const totalCount = parseInt(countRows[0]?.count ?? "0", 10);

      return {
        nodes: rows.map(dbRowToMachine),
        totalCount,
        hasNextPage: offset + limit < totalCount,
      };
    },

    machine: async (
      _parent: unknown,
      { id }: { id: string },
      context: GraphQLContext
    ) => {
      requireAuth(context);
      return getMachine(id);
    },

    recentTelemetry: async (
      _parent: unknown,
      { machineId, limit = 20 }: { machineId: string; limit?: number },
      context: GraphQLContext
    ) => {
      requireAuth(context);

      const { rows } = await pool.query<{
        machine_id: string;
        recorded_at: Date;
        values: KeyValue[];
      }>(
        `SELECT machine_id, recorded_at, values FROM telemetry
         WHERE machine_id=$1
         ORDER BY recorded_at DESC
         LIMIT $2`,
        [machineId, limit]
      );

      return rows.map((r) => ({
        machineId: r.machine_id,
        timestamp: toIsoString(r.recorded_at),
        values: r.values,
      }));
    },
  },

  Mutation: {
    ingestTelemetry: async (
      _parent: unknown,
      {
        machineId,
        recordedAt,
        values,
      }: { machineId: string; recordedAt: string; values: KeyValue[] },
      context: GraphQLContext
    ) => {
      requireAuth(context);
      return processTelemetry(machineId, recordedAt, new Date(), values);
    },

    acknowledgeAlert: async (
      _parent: unknown,
      { machineId, alertId }: { machineId: string; alertId: string },
      context: GraphQLContext
    ) => {
      requireAuth(context);

      const { rows } = await pool.query<AlertRow>(
        `UPDATE alerts SET acknowledged=TRUE
         WHERE id=$1 AND machine_id=$2
         RETURNING id, kind, severity, timestamp, last_hot_at, later_reading_at, readings,
                   acknowledged`,
        [alertId, machineId]
      );

      const acknowledged = rows[0];
      if (!acknowledged) throw new Error(`Alert ${alertId} not found`);

      await pubsub.publish(MACHINE_EVENT, {
        machineUpdated: await getMachine(machineId),
      });

      return dbRowToAlert(acknowledged);
    },
  },

  Subscription: {
    machineUpdated: {
      // The filter runs before execution, so an event for a different machine
      // is not executed and not sent. The field is non-null, so a resolve that
      // returned null for that event would send the subscriber an error.
      subscribe: withFilter(
        (_parent: unknown, _args: unknown, context: GraphQLContext) => {
          if (!context.user) throw new Error("Unauthorized");
          return pubsub.asyncIterator<{ machineUpdated: Machine }>([MACHINE_EVENT]);
        },
        (
          payload: { machineUpdated: Machine },
          { machineId }: { machineId?: string | null }
        ) => isMachineSubscribed(payload.machineUpdated.id, machineId)
      ),
    },
  },
};

const schema = makeExecutableSchema({ typeDefs, resolvers });
const app = express();
const httpServer = createServer(app);

app.use(
  cors({
    origin: (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(","),
    credentials: true,
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests, please slow down",
  })
);

app.get("/health", (_req: Request, res: Response) => res.sendStatus(200));

// REST ingestion endpoint for devices that speak plain HTTP rather than GraphQL.
app.post("/api/telemetry", bodyParser.json(), async (req: Request, res: Response) => {
  // The receive time is taken here, not in the consumer, so time spent in the
  // queue is not counted as time the server had not yet heard the reading.
  const receivedAt = new Date();
  const { machineId, recordedAt, values } = req.body ?? {};
  if (!machineId || !Array.isArray(values)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  try {
    validateTelemetryValues(values);
    parseRecordedAt(recordedAt);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }

  // Falls back to processing inline when the broker is unavailable, so the
  // stack still works without RabbitMQ running.
  if (rabbitChannel) {
    rabbitChannel.sendToQueue(
      TELEMETRY_QUEUE,
      Buffer.from(JSON.stringify({ machineId, recordedAt, receivedAt, values })),
      { persistent: true }
    );
    return res.status(202).json({ ok: true, queued: true });
  }

  try {
    await processTelemetry(machineId, recordedAt, receivedAt, values);
    return res.json({ ok: true, queued: false });
  } catch (err) {
    logger.error({ err }, "Inline telemetry processing failed");
    return res.status(400).json({ error: (err as Error).message });
  }
});

const wsServer = new WebSocketServer({ server: httpServer, path: "/graphql" });
const serverCleanup = useServer(
  {
    schema,
    // The browser cannot set headers on a WebSocket handshake, so the token
    // travels in connectionParams and the server reads it from there.
    context: (ctx): GraphQLContext => {
      const token = ctx.connectionParams?.authToken;
      return { user: verifyToken(typeof token === "string" ? `Bearer ${token}` : null) };
    },
  },
  wsServer
);

const apollo = new ApolloServer<GraphQLContext>({
  schema,
  // Machine -> alerts is the only nesting in the schema, so anything deeper
  // than a handful of levels is a client mistake or an abusive query.
  validationRules: [depthLimit(5)],
  plugins: [
    {
      async serverWillStart() {
        return {
          async drainServer() {
            await serverCleanup.dispose();
          },
        };
      },
    },
  ],
});

await apollo.start();

app.use(
  "/graphql",
  bodyParser.json(),
  expressMiddleware(apollo, {
    context: async ({ req }): Promise<GraphQLContext> => ({
      user: verifyToken(req.headers.authorization),
    }),
  })
);

await initDb();
await initRabbit();

// Partitions have to exist before the day they cover, so maintenance keeps
// running for as long as the process does.
const maintenanceTimer = setInterval(() => {
  runTelemetryMaintenance().catch((err) =>
    logger.error({ err }, "Telemetry maintenance failed")
  );
}, MAINTENANCE_INTERVAL_MS);
maintenanceTimer.unref();

const PORT = process.env.PORT ?? 4000;
httpServer.listen(PORT, () => {
  logger.info(`GraphQL ready at http://localhost:${PORT}/graphql`);
  logger.info(`Subscriptions ready at ws://localhost:${PORT}/graphql`);
  logger.info(`REST webhook at http://localhost:${PORT}/api/telemetry`);
});
