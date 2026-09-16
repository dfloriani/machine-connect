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

## 3. A reading is identified by the machine's time, and only the newest reading changes the machine

**Chosen:**

- A reading must include `recordedAt`: the time the machine took it, as ISO 8601 with a UTC
  offset. The server stores it as `recorded_at`, and also stores `received_at`: the time the
  reading entered the server.
- `(machine_id, recorded_at)` identifies a reading. `telemetry` has
  `UNIQUE (machine_id, recorded_at)`, and inserts use `ON CONFLICT DO NOTHING`. A reading that
  is already stored changes nothing: no machine update, no alert, no `MACHINE_EVENT`.
- `telemetry` is partitioned by the UTC day of `recorded_at`. Maintenance creates one
  partition per day, from `TELEMETRY_RETENTION_DAYS` ago to 3 days ahead.
- A reading whose `recorded_at` has no partition goes to `out_of_range_readings`. It changes
  only `machines.last_seen` and raises no alert. Maintenance deletes it when its
  `received_at` is older than `TELEMETRY_RETENTION_DAYS`.
- A reading changes the `machines` row only when its `recorded_at` is at least
  `machines.last_recorded_at` and not more than 5 minutes ahead of its `received_at`. A
  reading that does not change the machine is still stored.

**Rejected:**

- The server's time only. A reading that waits in the queue gets the time it is processed,
  so a backlog is stored as one burst, and an older reading that finishes last sets the
  machine's current status.
- The machine's time only. The delay between a reading and its arrival cannot be seen, so a
  clock error cannot be measured.
- Partitions by `received_at`. Postgres requires every unique index on a partitioned table
  to include the partition column, so `UNIQUE (machine_id, recorded_at)` is not allowed. A
  `SELECT` before each insert is not enforced by the database and reads every partition.
- `UNIQUE (machine_id, recorded_at, received_at)`. A POST that the machine sends again gets a
  new `received_at`, so only a message that RabbitMQ delivers again is caught.
- A reading id sent by the machine. It is another breaking API change, and the ids need their
  own table and retention.
- Rejecting a reading that has no partition. Its values can be correct when its time is
  wrong, and with both times stored the clock error can be measured.
- A `DEFAULT` partition. When it holds a row for a day, Postgres cannot create that day's
  partition, so every later reading for that day also goes into the `DEFAULT` partition, and
  retention does not drop it.
- Creating a partition when a reading needs it. A wrong clock decides how many tables exist,
  `CREATE TABLE ... PARTITION OF` locks all of `telemetry`, and two sessions that create the
  same partition at the same time can fail.
- The 3-day look-ahead as the limit for changing the machine. One reading stamped 2 days
  ahead sets `last_recorded_at` 2 days ahead, and no correct reading changes the machine for
  2 days.

**Why:** Only the machine knows the order in which it took its readings. Readings can finish
out of order (entry 1), wait in the queue, or arrive twice: RabbitMQ delivers a message again
when the process stops between `COMMIT` and `channel.ack`, and a machine sends a POST again
after a timeout. A machine does not take two readings in the same millisecond, so
`(machine_id, recorded_at)` identifies a reading. The server's own time is the one it can
trust, so it decides when an out-of-range reading is deleted.

**What it costs:**

- The machine row depends on the machine's clock. A clock more than 5 minutes fast never
  changes the machine. A clock that is set back does not change the machine until it passes
  `last_recorded_at` again.
- Retention follows the machine's time. The chart does not show `out_of_range_readings`.
- Each maintenance run creates `TELEMETRY_RETENTION_DAYS` + 4 partitions if they do not
  exist: one per day of retention, today, and 3 days ahead. That is 34 by default.
- Two different readings from one machine with the same `recorded_at` are stored once.
- `TelemetryPayload.timestamp` keeps its name and holds `recorded_at`. `received_at` is not
  in the GraphQL API.
- A database created before this change needs `docker compose down -v`, because there is no
  migration tool.

**Where:** `parseRecordedAt`, `isClockAhead` and `shouldApplyReading` in
`backend/lib/telemetry.ts`; `retentionCutoff`, `partitionsToCreate` and `isInPartitionRange`
in `backend/lib/partitions.ts`; `initDb()`, `runTelemetryMaintenance()`, `processTelemetry()`,
the consumer in `initRabbit()`, `POST /api/telemetry` and `ingestTelemetry` in
`backend/server.ts`.

## 4. Late hot readings from one hot period become one INFO alert

**Chosen:**

A late hot reading is a reading that gives `WARNING`, does not change the machine because a
newer reading was applied first, and arrives while the machine is not in `WARNING`.

All late hot readings from one hot period share one `INFO` alert of kind
`TEMPORARY_ANOMALY`. A hot period is a series of stored readings of one machine, in
`recorded_at` order, that all give `WARNING`.

Example: a machine was hot at 10:00:01, 10:00:02, 10:00:03 and 10:00:04, and normal at
10:00:05. The 10:00:05 reading arrives first and changes the machine. The four hot readings
arrive after it, in any order. The result is one alert: from 10:00:01 to 10:00:04, over by
10:00:05, with the highest temperature and rpm of the four readings.

To find its alert, the server reads the stored reading just before and just after the late
hot reading, by `recorded_at`:

- Neither of the two is hot: a new alert starts with this reading.
- One of the two is hot and belongs to an alert: that alert grows to include this reading.
- One of the two is hot and belongs to no alert: that reading was stored while the machine
  was in `WARNING`, so the `WARNING` alert already covers this period. No alert.

Other rules:

- A late normal reading between the end of an alert and its "over by" time becomes the new
  "over by" time.
- An acknowledged alert becomes unacknowledged only when its highest temperature or rpm goes
  up.
- `telemetry.status` stores the status of each reading, so the server can find hot readings
  without reading `values` again.

**Rejected:**

- A `WARNING` alert. The machine is normal again, so the alert asks for action on a state
  that has ended.
- One alert per late hot reading. A machine that was hot for 20 minutes, with one reading a
  second, writes 1,200 alerts.
- Joining alerts that are less than N minutes apart. N is arbitrary, and two separate hot
  periods closer than N become one alert.
- No alert for backfilled readings. The API cannot tell a backfill from other late readings.
- Splitting an alert when a normal reading arrives inside its period. It needs a second alert
  for data that only matters for reporting.
- `${machineId}-${Date.now()}` as the alert id. Two alerts for one machine in the same
  millisecond fail on the primary key.

**Why:** An operator acts on the machine's current state. A late hot reading describes a state
that has already ended, so it is kept for reporting and must not fill the dashboard.

**What it costs:**

- Each late hot reading runs two extra queries on `telemetry` and one alert update.
- `telemetry.status` keeps the status by the thresholds at the time of insert.
- A normal reading inside a period does not split its alert.
- The alert shows the highest values, not each reading.
- A hot period can get no alert. Example: readings at 10:00:05 (hot), 10:00:06 (hot),
  10:00:07 (normal), 10:00:10 (hot) and 10:00:11 (normal). 10:00:07 and 10:00:10 arrive
  first, so the machine is in `WARNING`. 10:00:05 arrives next and raises no alert, because
  the machine is in `WARNING`. 10:00:11 arrives, and the machine is normal again. 10:00:06
  arrives last. The stored reading before it, 10:00:05, is hot and belongs to no alert, so
  10:00:06 also raises no alert.

**Where:** `isTemporaryAnomaly`, `temporaryAnomalyAction`, `peakReadings` and `isPeakRaised` in
`backend/lib/telemetry.ts`; `recordTemporaryAnomaly()` and `endTemporaryAnomalyEarlier()` in
`backend/server.ts`; `alertText()` in `frontend/src/lib/alerts.ts`.

## 5. An alert carries a kind and times, and the frontend builds its text

**Chosen:** The `alerts` table and the GraphQL `Alert` type have a `kind` (the `AlertKind`
enum) and ISO times, and no `message`. `alertText()` in `frontend/src/lib/alerts.ts` builds
the sentence for each kind and formats the times with `toLocaleTimeString()`.

**Rejected:**

- A `message` text built on the server. The server builds it once, when it inserts the
  alert, and the times inside the text are formatted in the server's time zone, which is
  UTC in the container. Every other time on the dashboard is formatted by the browser in
  the viewer's time zone. The wording also cannot change without a backend change, and old
  alerts keep the old wording.
- Both `message` and `kind`. The two can disagree, and the client still has to choose which
  one to show.
- Choosing the sentence from `severity`. Each kind has one severity today, so `case "INFO":`
  gives the same sentence, but a reader cannot see that `INFO` means a late hot reading, and
  a change to the severity of an alert also changes its sentence.
- Choosing the sentence by whether `laterReadingAt` is `null`. The meaning is in whether an
  optional field is empty, and a later kind that also sets `laterReadingAt` breaks it.

**Why:** Times are data, and only the browser knows the viewer's time zone. With a kind and
times, the dashboard formats alert times the same way as "Last seen" and the chart. The two
kinds have different fields: `TEMPORARY_ANOMALY` has `lastHotAt`, `laterReadingAt` and
`readings`, and `ENTERED_WARNING` has none of them. `kind` names which of the two a row is.

**What it costs:** A new alert kind needs a change in three places: the `AlertKind` enum in
the schema, the `AlertKind` type in `frontend/src/types.ts`, and a case in `alertText()`.
A client other than this dashboard receives no readable text and has to build its own. A
database created before this change has a `message` column and no `kind` column, and
needs `docker compose down -v`.

**Where:** `initDb()`, the `Alert` type and `AlertKind` enum in `backend/server.ts`;
`frontend/src/lib/alerts.ts`, `frontend/src/types.ts`, `AlertFields` in
`frontend/src/graphql/operations.ts`.
