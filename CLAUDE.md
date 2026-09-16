# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Machine Connect" is a real-time CNC machine monitoring dashboard. Telemetry arrives over a REST webhook, is queued through RabbitMQ, persisted to Postgres, and pushed to the React frontend over a GraphQL subscription.

Two independent packages, no root package.json: [backend/](backend/) (Node + TypeScript + Apollo Server 4, ESM) and [frontend/](frontend/) (Vite + React 18 + TypeScript + Apollo Client). Each carries its own tsconfig, ESLint and Prettier config, and everything runs inside containers. Config files must live inside their package: only `./backend` and `./frontend` are mounted into the containers, so a repo-root `.prettierrc` or `.eslintrc.json` is invisible to the tooling that runs there and it silently falls back to defaults.

## Commands

Docker Compose runs the whole stack with source bind-mounts, `tsx watch`, and Vite HMR:

```bash
cp .env.example .env                       # POSTGRES_*/RABBITMQ_* credentials, also used for compose interpolation
cp frontend/.env.example frontend/.env     # VITE_GRAPHQL_HTTP / VITE_GRAPHQL_WS
docker compose up --build
```

Checks run inside the containers:

```bash
docker compose exec backend  npm test              # node:test through tsx
docker compose exec frontend npm test              # vitest run
docker compose exec backend  npm run typecheck     # tsc --noEmit
docker compose exec frontend npm run typecheck
docker compose exec backend  npm run lint
docker compose exec frontend npm run lint
```

A single backend test: `npx tsx --test tests/telemetry.test.ts`. A single frontend test: `npx vitest run src/lib/telemetry.test.ts`.

## Architecture

**Telemetry flow.** Every reading goes through `processTelemetry()` in [backend/server.ts](backend/server.ts).

Ways in:

- `POST /api/telemetry` validates the reading, puts it on the durable `telemetry` RabbitMQ queue and returns `202`. The consumer in the same process calls `processTelemetry()`.
- If the broker is unavailable, the endpoint calls `processTelemetry()` inline and returns `200` with `queued: false`.
- The `ingestTelemetry` mutation calls `processTelemetry()` directly.

Steps in `processTelemetry()`:

1. Validate the values and `recordedAt`, and derive the status.
2. Start a transaction and lock the machine row with `SELECT … FOR UPDATE`.
3. Insert into `telemetry`, or into `out_of_range_readings` when `isInPartitionRange` is false, with `ON CONFLICT DO NOTHING`. If no row is inserted, the reading is already stored: commit, skip steps 4 and 5, and publish nothing.
4. Update `machines`: the whole row when `shouldApplyReading` allows it, otherwise only `last_seen`. An out-of-range reading is never applied.
5. Raise an alert: `WARNING` on the edge into WARNING, or add a late hot reading to the `INFO` alert of its hot period. An out-of-range reading raises no alert.
6. `COMMIT`, then publish `MACHINE_EVENT`.

Rules to keep:

- **One reading per machine at a time.** The row lock makes a second reading for the same machine wait, so the edge rule sees the status the previous reading wrote. Put new writes on the transaction's `client`, not on `pool.query`, which uses a different connection outside the transaction (DECISIONS.md, entry 1).
- **Consumer limit.** The consumer holds at most `CONSUMER_PREFETCH` (5) unacknowledged messages. Keep it below the `pg` pool size of 10 (DECISIONS.md, entry 2).
- **Two times per reading.** `recorded_at` comes from the machine. `received_at` is taken where the reading enters the server: the REST handler puts it in the queue message, and the mutation takes it in the resolver.
- **Newest reading wins.** A reading changes `machines` only when it is at least as new as `machines.last_recorded_at` and not more than 5 minutes ahead of `received_at`.
- **One row per reading.** `(machine_id, recorded_at)` identifies a reading, so a message RabbitMQ delivers again or a POST the machine sends again writes nothing. `alerts` has `UNIQUE (machine_id, timestamp)`, because no two alerts start at the same reading (DECISIONS.md, entry 3).
- **Late hot reading.** If it gave WARNING and the machine is no longer in WARNING, it joins the `INFO` alert of kind `TEMPORARY_ANOMALY` for its hot period: the stored readings next to it, by `recorded_at`, decide whether an alert starts, grows, or nothing happens. The alert keeps the period, peaks and "over by" time, and becomes unacknowledged only when a peak goes up (DECISIONS.md, entry 4).

**Pure logic is extracted for testing.** [backend/lib/telemetry.ts](backend/lib/telemetry.ts) holds `validateTelemetryValues`, `deriveStatus`, `shouldRaiseAlert`, `toKeyValueMap`, `parseRecordedAt`, `shouldApplyReading`, `isClockAhead`, `isTemporaryAnomaly`, `temporaryAnomalyAction`, `peakReadings`, `isPeakRaised` and the threshold/limit constants, so [backend/tests/telemetry.test.ts](backend/tests/telemetry.test.ts) runs with no database or broker. Keep new business rules there rather than inline in resolvers.

**One query, one subscription, deliberately.** [App.tsx](frontend/src/App.tsx) owns the single paginated `GET_MACHINES` query plus one `MACHINE_UPDATED` subscription with no `machineId` argument, and passes plain data down; [MachineList.tsx](frontend/src/components/MachineList.tsx) and [MachineCard.tsx](frontend/src/components/MachineCard.tsx) get their data as props and run no queries or subscriptions; the only operation a card sends is the `ACKNOWLEDGE_ALERT` mutation. This replaced a per-card query and per-card subscription design, and the README explains the change as a learning point, so **do not reintroduce per-component fetching.** Cards update because the subscription requests the same `MachineFields` fragment, so payloads normalize into `MachineStatus:<id>` and re-render the matching card; `updateQuery` intentionally returns `prev` untouched. One consequence: machines added after load do not appear until a refetch.

**Cache policies carry real weight.** `MachineStatus.alerts` has a `merge` that unions by id (Apollo would otherwise replace the array and drop alerts absent from a payload), and optimistic responses echo the existing alert rather than fabricating fields, because `Alert` is normalized by id and fabricated values leak to every view. Both live in [apolloClient.ts](frontend/src/apolloClient.ts) and [MachineCard.tsx](frontend/src/components/MachineCard.tsx).

**Alerts are data; the frontend writes the text.** An alert has a `kind` and ISO times, and no message.

- `alertText()` in [frontend/src/lib/alerts.ts](frontend/src/lib/alerts.ts) builds the sentence and formats times in the viewer's local time zone.
- A new alert kind needs three changes: the `AlertKind` enum in the schema, the `AlertKind` type in [frontend/src/types.ts](frontend/src/types.ts), and a case in `alertText()` (DECISIONS.md, entry 5).

**Subscription filtering happens before execution.** Every event goes to the one `MACHINE_EVENT` topic; `withFilter` calls `isMachineSubscribed` from [backend/lib/subscriptions.ts](backend/lib/subscriptions.ts) for each subscriber, so an event for a different machine is not executed or sent. `PubSub` is in-memory, so multiple backend instances would not share events.

**WebSocket connection state reaches React through window events.** `WS_STATUS_EVENTS` in [apolloClient.ts](frontend/src/apolloClient.ts) is the single source for the event names; [ConnectionStatus.tsx](frontend/src/components/ConnectionStatus.tsx) subscribes to them.

**Auth is a development stub.** `DEV_TOKEN = "dev-token-machine-connect"` short-circuits to an admin user; anything else is verified as a JWT against `JWT_SECRET`. Every resolver calls `requireAuth`. HTTP reads the `Authorization` header, WebSocket reads `connectionParams.authToken`, because browsers cannot set headers on a WebSocket handshake.

## Conventions

- Backend is TypeScript ESM with top-level `await`: `tsx watch` in development, `tsc` to `dist/` in the image. Schema and resolvers live inline in `server.ts`; `types/graphql-depth-limit.d.ts` shims the one untyped dependency; `initDb()` creates tables on boot and seeds `M-001..M-003` (no migration tool).
- `telemetry` is partitioned by the UTC day of `recorded_at`, so the unique key `(machine_id, recorded_at)` is allowed. `runTelemetryMaintenance()` creates partitions from `TELEMETRY_RETENTION_DAYS` ago to 3 days ahead, drops older ones, and deletes `out_of_range_readings` rows by `received_at`, at boot and every six hours; the naming, date maths and `isInPartitionRange` are pure functions in [backend/lib/partitions.ts](backend/lib/partitions.ts). `isInPartitionRange` accepts one day less than maintenance creates, and an insert fails if its partition is missing, so change the two together. Because there is no migration tool, maintenance detects a non-partitioned `telemetry` table and disables itself with a warning instead of crashing.
- Shared frontend types live in [frontend/src/types.ts](frontend/src/types.ts); GraphQL documents live only in [frontend/src/graphql/operations.ts](frontend/src/graphql/operations.ts) and compose the `MachineFields` and `AlertFields` fragments. There is no codegen.
- Guards to respect when extending the API: `depthLimit(5)`, 200 req/min rate limit, max 50 telemetry values per payload, `temperature` in [-50, 2000], `rpm` in [0, 100000].
- Telemetry values are always `{key, value}` **string** pairs on the wire, parsed at the edges (`processTelemetry`, `toChartPoints`). Every reading also needs `recordedAt`, an ISO 8601 time with a UTC offset (REST body field and `ingestTelemetry` argument). `recentTelemetry` returns newest-first by `recorded_at` and exposes it as `timestamp`; [frontend/src/lib/telemetry.ts](frontend/src/lib/telemetry.ts) sorts chronologically for the chart.
- Commits follow Conventional Commits.
