import express, { type Request, type Response } from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { PubSub, withFilter } from "graphql-subscriptions";
import { createServer } from "http";
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
  type KeyValue,
  type MachineState,
} from "./lib/telemetry.js";
import { upcomingPartitions, expiredPartitions } from "./lib/partitions.js";
import { isMachineSubscribed } from "./lib/subscriptions.js";

interface AuthUser {
  userId: string;
  role: string;
}

interface GraphQLContext {
  user: AuthUser | null;
}

/** Shapes the API returns, with timestamps already serialised. */
interface Alert {
  id: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  message: string;
  timestamp: string;
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
interface AlertRow extends Omit<Alert, "timestamp"> {
  timestamp: Date | string;
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
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES machines(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS telemetry (
      id BIGINT GENERATED ALWAYS AS IDENTITY,
      machine_id TEXT NOT NULL REFERENCES machines(id),
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      values JSONB NOT NULL,
      PRIMARY KEY (id, timestamp)
    ) PARTITION BY RANGE (timestamp);

    CREATE INDEX IF NOT EXISTS telemetry_machine_time_idx
      ON telemetry (machine_id, timestamp DESC);
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

/** Creates the partitions the next few days need and drops expired ones. */
async function runTelemetryMaintenance(now = new Date()): Promise<void> {
  if (!(await isTelemetryPartitioned())) {
    logger.warn(
      "telemetry is not partitioned, so retention is disabled. Recreate the database volume to enable it."
    );
    return;
  }

  for (const { name, from, to } of upcomingPartitions(now, PARTITION_DAYS_AHEAD)) {
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
      const { machineId, values } = JSON.parse(msg.content.toString());
      await processTelemetry(machineId, values);
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

function dbRowToMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    temperature: row.temperature,
    rpm: row.rpm,
    lastSeen: toIsoString(row.last_seen),
    alerts: (row.alerts ?? []).map((a) => ({
      id: a.id,
      severity: a.severity,
      message: a.message,
      timestamp: toIsoString(a.timestamp),
      acknowledged: a.acknowledged,
    })),
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

/**
 * The single path every reading goes through, whether it arrived from the
 * queue or straight from the ingestTelemetry mutation.
 */
async function processTelemetry(machineId: string, values: unknown): Promise<Machine> {
  const readings: KeyValue[] = validateTelemetryValues(values);

  const kv = toKeyValueMap(readings);
  const newStatus = deriveStatus(kv);
  const now = new Date();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // A second reading for this machine waits here until this transaction
    // ends, and then reads the status this one wrote.
    const { rows } = await client.query<{ status: MachineState }>(
      "SELECT status FROM machines WHERE id = $1 FOR UPDATE",
      [machineId]
    );
    const prev = rows[0];
    if (!prev) throw new Error(`Unknown machine ${machineId}`);

    await client.query(
      `UPDATE machines
       SET status=$1, temperature=COALESCE($2, temperature),
           rpm=COALESCE($3, rpm), last_seen=$4
       WHERE id=$5`,
      [
        newStatus,
        kv.temperature ? parseFloat(kv.temperature) : null,
        kv.rpm ? parseInt(kv.rpm, 10) : null,
        now,
        machineId,
      ]
    );

    await client.query(
      "INSERT INTO telemetry (machine_id, timestamp, values) VALUES ($1, $2, $3)",
      [machineId, now, JSON.stringify(readings)]
    );

    if (shouldRaiseAlert(prev.status, newStatus)) {
      await client.query(
        `INSERT INTO alerts (id, machine_id, severity, message, timestamp)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          `${machineId}-${Date.now()}`,
          machineId,
          "WARNING",
          `Machine ${machineId} entered WARNING state`,
          now,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const updated = (await getMachine(machineId)) as Machine;
  await pubsub.publish(MACHINE_EVENT, { machineUpdated: updated });
  logger.info({ machineId, newStatus }, "Telemetry processed");
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

  type Alert {
    id: ID!
    severity: AlertSeverity!
    message: String!
    timestamp: String!
    acknowledged: Boolean!
  }

  enum AlertSeverity {
    INFO
    WARNING
    CRITICAL
  }

  type TelemetryPayload {
    machineId: ID!
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
    ingestTelemetry(machineId: ID!, values: [KeyValueInput!]!): MachineStatus!
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
        timestamp: Date;
        values: KeyValue[];
      }>(
        `SELECT machine_id, timestamp, values FROM telemetry
         WHERE machine_id=$1
         ORDER BY timestamp DESC
         LIMIT $2`,
        [machineId, limit]
      );

      return rows.map((r) => ({
        machineId: r.machine_id,
        timestamp: toIsoString(r.timestamp),
        values: r.values,
      }));
    },
  },

  Mutation: {
    ingestTelemetry: async (
      _parent: unknown,
      { machineId, values }: { machineId: string; values: KeyValue[] },
      context: GraphQLContext
    ) => {
      requireAuth(context);
      return processTelemetry(machineId, values);
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
         RETURNING id, severity, message, timestamp, acknowledged`,
        [alertId, machineId]
      );

      const acknowledged = rows[0];
      if (!acknowledged) throw new Error(`Alert ${alertId} not found`);

      await pubsub.publish(MACHINE_EVENT, {
        machineUpdated: await getMachine(machineId),
      });

      return { ...acknowledged, timestamp: toIsoString(acknowledged.timestamp) };
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
  const { machineId, values } = req.body ?? {};
  if (!machineId || !Array.isArray(values)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  try {
    validateTelemetryValues(values);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }

  // Falls back to processing inline when the broker is unavailable, so the
  // stack still works without RabbitMQ running.
  if (rabbitChannel) {
    rabbitChannel.sendToQueue(
      TELEMETRY_QUEUE,
      Buffer.from(JSON.stringify({ machineId, values })),
      { persistent: true }
    );
    return res.status(202).json({ ok: true, queued: true });
  }

  try {
    await processTelemetry(machineId, values);
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
