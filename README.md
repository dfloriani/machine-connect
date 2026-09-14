# Machine Connect

A small real-time dashboard for monitoring CNC machines: machines push telemetry
readings, the backend stores them and derives a status, and connected browsers
see the change immediately over a GraphQL subscription.

I built it to get back into GraphQL after several years away from it. The domain
is deliberately simple so the interesting part is the plumbing: schema design,
subscriptions, cache normalisation, and where a naive client design starts
making too many requests.

## Stack

TypeScript on both sides.

| Layer    | Choice                                                                       |
| -------- | ---------------------------------------------------------------------------- |
| Backend  | Node.js, TypeScript, Apollo Server 4, Express, `graphql-ws` for subscriptions |
| Storage  | PostgreSQL                                                                     |
| Ingest   | RabbitMQ queue in front of the writes                                          |
| Frontend | React 18, TypeScript, Vite, Apollo Client, Recharts                            |
| Runtime  | Docker Compose for the whole stack                                             |

The backend runs from source with `tsx` in development and from `tsc` output in
the image; the frontend is served by Vite.

## Running it

Everything runs in containers, so Docker is the only requirement.

```bash
cp .env.example .env                       # database and broker credentials
cp frontend/.env.example frontend/.env     # GraphQL endpoints for the browser
docker compose up --build
```

| Service       | URL                             |
| ------------- | ------------------------------- |
| Dashboard     | http://localhost:3000           |
| GraphQL       | http://localhost:4000/graphql   |
| Subscriptions | ws://localhost:4000/graphql     |
| RabbitMQ UI   | http://localhost:15672          |

The database is created and seeded with three machines on first boot.

## Trying it out

Requests need an auth token. For local development the backend accepts a fixed
one, `dev-token-machine-connect`, which the frontend also uses.

Send a reading over the REST webhook (this is what a machine would do):

```bash
curl -X POST http://localhost:4000/api/telemetry \
  -H "Content-Type: application/json" \
  -d '{"machineId":"M-001","values":[{"key":"temperature","value":"95"},{"key":"rpm","value":"5200"}]}'
```

Anything above 90 °C or 5000 rpm moves the machine into `WARNING` and raises an
alert. Watch the dashboard update without a refresh, or subscribe from another
client:

```graphql
subscription {
  machineUpdated {
    id
    status
    temperature
    alerts {
      message
      acknowledged
    }
  }
}
```

## Checks

```bash
docker compose exec backend npm test               # node:test via tsx, telemetry rules
docker compose exec frontend npm test              # vitest, chart transforms
docker compose exec backend npm run typecheck      # tsc --noEmit
docker compose exec frontend npm run typecheck
docker compose exec backend npm run lint
docker compose exec frontend npm run lint
```

## Notes to myself on the GraphQL side

Things I worked through while building this, mostly the reasons behind decisions
that are not obvious from the code:

**One query for the dashboard, not one per card.** The first version had every
machine card run its own `machine(id:)` query and its own subscription. It
worked, but ten cards meant ten queries, and ten subscriptions that the server
ran separately on one WebSocket connection, for data the list query had already
returned. Now `App` runs a single paginated query and passes plain data down.
The cards run no queries or subscriptions. `MachineCard` only sends the
`acknowledgeAlert` mutation.

**A single subscription, and the cache does the routing.** `machineUpdated`
takes an optional `machineId`, but the dashboard subscribes without one and lets
Apollo's normalised cache write each payload into the right `MachineStatus:<id>`
entry. Because the subscription requests the same fragment as the query, the
matching card re-renders on its own and `updateQuery` only has to leave the page
membership alone.

**Fragments are what make that work.** `MachineFields` is requested identically
by the query and the subscription, so every source writes the same shape into
the cache. When they drift, you get half-updated cards and refetches you did not
ask for.

**Filter subscription events before execution, not in `resolve`.**
`machineUpdated` returns `MachineStatus!`, which cannot be null. If `resolve`
returns `null` for an event from a different machine, GraphQL sends the
subscriber an error, not an empty message. `withFilter` compares each event
with the subscriber's `machineId` before execution. An event that does not
match is not executed and not sent.

**Merging alerts instead of replacing them.** Apollo replaces array fields by
default, so an incoming payload without a given alert would silently drop it
from a cached machine. The `alerts` field has a `merge` policy that unions by
id.

**Optimistic responses should echo real data.** My first attempt returned a
made-up `Alert` with an empty message. Since alerts are normalised by id, that
briefly blanked the message everywhere it was displayed. Echoing the alert I
already have and only flipping `acknowledged` fixes it.

**Guard the query surface, not just the resolvers.** A public GraphQL endpoint
lets clients shape their own queries, so the server sets a depth limit, a rate
limit, and validates telemetry payloads before anything reaches the database.

## Retention

Telemetry is the only table that grows without bound, so it is partitioned by
UTC day and old partitions are dropped on a schedule. `TELEMETRY_RETENTION_DAYS`
sets the window and defaults to 30.

This applies to raw sensor samples only. Alerts are kept indefinitely, so the
record of what went wrong on a machine outlives the readings that triggered it.

Dropping a partition is a catalog operation, unlike a bulk `DELETE`, which would
write as much WAL as the rows it removes and leave the space for vacuum to
reclaim. Maintenance runs at startup and every six hours: it creates the
partitions for the next few days, so an insert never arrives before its
partition exists, and drops any whose day has fallen outside the window.
Because partitions are dropped whole, up to one extra day is kept.

```bash
docker compose exec postgres psql -U app -d machineconnect -c "\d+ telemetry"
```

The table was not partitioned in earlier versions of this project. There is no
migration tool here, so on an existing database the server logs a warning and
leaves retention disabled; recreating the volume with `docker compose down -v`
enables it.

## Known trade-offs

These are deliberate for a project this size, and are the first things I would
change for a real deployment:

- **Auth is a stub.** A hardcoded development token stands in for real tokens
  from an identity provider.
- **Subscriptions are in-process.** `graphql-subscriptions`' `PubSub` is
  in-memory, so a second backend instance would not see the first's events.
  Horizontal scaling needs a Redis-backed pub/sub.
- **No migrations.** The schema is created on boot with `CREATE TABLE IF NOT
  EXISTS`, which is fine for a demo and not for anything that has to change
  shape later.
- **No generated types.** Response types are hand-written; a schema-driven
  codegen step would keep them honest.
- **No downsampling.** Raw readings are dropped once they age out (see
  Retention above) rather than being rolled up into hourly or daily aggregates,
  so charts cannot go back further than the retention window. A real deployment
  would keep raw data briefly and aggregates for years, which is what
  TimescaleDB's continuous aggregates exist to do.

## License

MIT. See [LICENSE](LICENSE).
