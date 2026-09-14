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

**Telemetry flow.** `POST /api/telemetry` validates and enqueues to the durable `telemetry` RabbitMQ queue, returning `202`; the consumer in the same process calls `processTelemetry()`. If the broker is unavailable the endpoint processes inline and returns `200` with `queued: false`. The `ingestTelemetry` mutation calls `processTelemetry()` directly. All paths converge on that one function in [backend/server.ts](backend/server.ts): validate, derive status, update `machines`, append to `telemetry`, raise an alert on the edge into WARNING, publish `MACHINE_EVENT`.

**Pure logic is extracted for testing.** [backend/lib/telemetry.ts](backend/lib/telemetry.ts) holds `validateTelemetryValues`, `deriveStatus`, `shouldRaiseAlert`, `toKeyValueMap` and the threshold/limit constants, so [backend/tests/telemetry.test.ts](backend/tests/telemetry.test.ts) runs with no database or broker. Keep new business rules there rather than inline in resolvers.

**One query, one subscription, deliberately.** [App.tsx](frontend/src/App.tsx) owns the single paginated `GET_MACHINES` query plus one `MACHINE_UPDATED` subscription with no `machineId` argument, and passes plain data down; [MachineList.tsx](frontend/src/components/MachineList.tsx) and [MachineCard.tsx](frontend/src/components/MachineCard.tsx) get their data as props and run no queries or subscriptions; the only operation a card sends is the `ACKNOWLEDGE_ALERT` mutation. This replaced a per-card query and per-card subscription design, and the README explains the change as a learning point, so **do not reintroduce per-component fetching.** Cards update because the subscription requests the same `MachineFields` fragment, so payloads normalize into `MachineStatus:<id>` and re-render the matching card; `updateQuery` intentionally returns `prev` untouched. One consequence: machines added after load do not appear until a refetch.

**Cache policies carry real weight.** `MachineStatus.alerts` has a `merge` that unions by id (Apollo would otherwise replace the array and drop alerts absent from a payload), and optimistic responses echo the existing alert rather than fabricating fields, because `Alert` is normalized by id and fabricated values leak to every view. Both live in [apolloClient.ts](frontend/src/apolloClient.ts) and [MachineCard.tsx](frontend/src/components/MachineCard.tsx).

**Subscription filtering happens before execution.** Every event goes to the one `MACHINE_EVENT` topic; `withFilter` calls `isMachineSubscribed` from [backend/lib/subscriptions.ts](backend/lib/subscriptions.ts) for each subscriber, so an event for a different machine is not executed or sent. `PubSub` is in-memory, so multiple backend instances would not share events.

**WebSocket connection state reaches React through window events.** `WS_STATUS_EVENTS` in [apolloClient.ts](frontend/src/apolloClient.ts) is the single source for the event names; [ConnectionStatus.tsx](frontend/src/components/ConnectionStatus.tsx) subscribes to them.

**Auth is a development stub.** `DEV_TOKEN = "dev-token-machine-connect"` short-circuits to an admin user; anything else is verified as a JWT against `JWT_SECRET`. Every resolver calls `requireAuth`. HTTP reads the `Authorization` header, WebSocket reads `connectionParams.authToken`, because browsers cannot set headers on a WebSocket handshake.

## Conventions

- Backend is TypeScript ESM with top-level `await`: `tsx watch` in development, `tsc` to `dist/` in the image. Schema and resolvers live inline in `server.ts`; `types/graphql-depth-limit.d.ts` shims the one untyped dependency; `initDb()` creates tables on boot and seeds `M-001..M-003` (no migration tool).
- `telemetry` is partitioned by UTC day. `runTelemetryMaintenance()` creates partitions a few days ahead and drops those older than `TELEMETRY_RETENTION_DAYS`, at boot and every six hours; the naming and date maths are pure functions in [backend/lib/partitions.ts](backend/lib/partitions.ts). Inserts fail if a partition is missing for their timestamp, so keep the look-ahead when changing that code. Because there is no migration tool, maintenance detects a non-partitioned `telemetry` table and disables itself with a warning instead of crashing.
- Shared frontend types live in [frontend/src/types.ts](frontend/src/types.ts); GraphQL documents live only in [frontend/src/graphql/operations.ts](frontend/src/graphql/operations.ts) and compose the `MachineFields` and `AlertFields` fragments. There is no codegen.
- Guards to respect when extending the API: `depthLimit(5)`, 200 req/min rate limit, max 50 telemetry values per payload, `temperature` in [-50, 2000], `rpm` in [0, 100000].
- Telemetry values are always `{key, value}` **string** pairs on the wire, parsed at the edges (`processTelemetry`, `toChartPoints`). `recentTelemetry` returns newest-first; [frontend/src/lib/telemetry.ts](frontend/src/lib/telemetry.ts) sorts chronologically for the chart.
- Commits follow Conventional Commits.
