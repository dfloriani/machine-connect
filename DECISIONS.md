# Decisions

## 1. Readings for one machine are serialised by a row lock in one transaction

**Chosen:** `processTelemetry()` runs its writes in one transaction that starts with
`SELECT status FROM machines WHERE id = $1 FOR UPDATE`. The `UPDATE machines`, the
`INSERT INTO telemetry` and the optional `INSERT INTO alerts` follow in the same
transaction. The machine is read again and `MACHINE_EVENT` is published after `COMMIT`.

**Rejected:**

- `channel.prefetch(1)` on the RabbitMQ consumer alone. It makes the consumer process one
  message at a time, but the inline REST path and the `ingestTelemetry` mutation still call
  `processTelemetry()` in parallel, so the race stays on those two paths.
- A unique constraint that rejects a second alert for the same machine. An alert has no
  natural key for one "entered WARNING" event, so the constraint needs a new column that
  identifies the event, and a reading that violates it fails after the machine row is
  already written.

**Why:** The edge rule in `shouldRaiseAlert()` compares the previous status with the new
one. Without a lock, readings that run at the same time all read the previous status
before any of them writes, so each of them sees the edge into `WARNING`. Without the lock,
a backlog of 20 hot readings for one machine writes about 9 alerts, and some readings fail
with a duplicate `alerts_pkey`, because the alert id is `${machineId}-${Date.now()}`. With
the lock, the same backlog writes 1 alert and no reading fails. The lock is in PostgreSQL,
so it covers all three paths into `processTelemetry()`, and a failed insert rolls back the
machine update with it.

**What it costs:** Readings for one machine are processed one at a time. Readings for
different machines do not wait for each other. A reading holds a pooled connection while
it waits for the lock, and `pg.Pool` has 10 connections by default, so readings for one
busy machine take connections that GraphQL queries also need. The lock makes readings for
one machine run one after another, but not always in the order in which they were sent.

**Where:** `processTelemetry()` in `backend/server.ts`.

## 2. The telemetry consumer holds at most 5 unacknowledged readings

**Chosen:** `channel.prefetch(CONSUMER_PREFETCH)` with `CONSUMER_PREFETCH = 5`. RabbitMQ
sends the consumer a new message only while fewer than 5 of its messages are not yet
acknowledged.

**Rejected:**

- No limit. RabbitMQ then sends the whole backlog at once, and every message starts
  `processTelemetry()`. Readings for one machine wait for the row lock (entry 1) while each
  holds a pooled connection, so a backlog can hold all 10 connections, and GraphQL queries
  wait until the backlog clears.
- `prefetch(1)`. It processes the queue in order, but one reading at a time for all
  machines, so one slow write delays every machine. It orders only the queue path, and the
  inline REST path and the `ingestTelemetry` mutation still run in parallel.

**Why:** 5 is below the pool size of 10, so at least 5 connections stay free for GraphQL
queries and partition maintenance, and readings for different machines still run in
parallel.

**What it costs:** At most 5 queued readings are in progress at one time, and the rest wait
in RabbitMQ. The limit is tied to the pool size by a comment only: if the pool gets fewer
than 6 connections, the consumer can again hold all of them.

**Where:** `CONSUMER_PREFETCH` and `initRabbit()` in `backend/server.ts`.
