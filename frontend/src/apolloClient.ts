import {
  ApolloClient,
  InMemoryCache,
  HttpLink,
  split,
  from,
  Reference,
  StoreObject,
} from "@apollo/client";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { getMainDefinition } from "@apollo/client/utilities";
import { onError } from "@apollo/client/link/error";
import { setContext } from "@apollo/client/link/context";
import { createClient } from "graphql-ws";

const HTTP_ENDPOINT =
  import.meta.env.VITE_GRAPHQL_HTTP ?? "http://localhost:4000/graphql";
const WS_ENDPOINT = import.meta.env.VITE_GRAPHQL_WS ?? "ws://localhost:4000/graphql";

// Development-only credential that the backend accepts as an admin user.
// A real client would read a token issued at login instead.
const AUTH_TOKEN = "dev-token-machine-connect";

export type WsStatus = "connected" | "disconnected" | "error";

/** Window events the socket emits so React can render the connection state. */
export const WS_STATUS_EVENTS: Record<WsStatus, string> = {
  connected: "ws:connected",
  disconnected: "ws:closed",
  error: "ws:error",
};

const errorLink = onError(({ graphQLErrors, networkError }) => {
  graphQLErrors?.forEach(({ message, path }) =>
    console.error(`[GraphQL error] ${message} (path: ${path})`)
  );
  if (networkError) console.error("[Network error]", networkError);
});

const authLink = setContext((_, { headers }) => ({
  headers: { ...headers, authorization: `Bearer ${AUTH_TOKEN}` },
}));

const httpLink = new HttpLink({ uri: HTTP_ENDPOINT });

const wsClient = createClient({
  url: WS_ENDPOINT,
  retryAttempts: 10,
  // WebSocket handshakes cannot carry an Authorization header, so the token
  // goes through connectionParams and the server reads it from there.
  connectionParams: { authToken: AUTH_TOKEN },
  on: {
    connected: () => window.dispatchEvent(new Event(WS_STATUS_EVENTS.connected)),
    closed: () => window.dispatchEvent(new Event(WS_STATUS_EVENTS.disconnected)),
    error: (err) => {
      console.error("[WS] Error", err);
      window.dispatchEvent(new Event(WS_STATUS_EVENTS.error));
    },
  },
});

const wsLink = new GraphQLWsLink(wsClient);

// Cached alerts arrive either as normalised references or as plain objects,
// depending on whether the entity is already in the cache.
type CachedAlert = Reference | StoreObject;

// Subscriptions go over the socket, queries and mutations over HTTP.
const splitLink = split(
  ({ query }) => {
    const definition = getMainDefinition(query);
    return (
      definition.kind === "OperationDefinition" && definition.operation === "subscription"
    );
  },
  wsLink,
  authLink.concat(httpLink)
);

const cache = new InMemoryCache({
  typePolicies: {
    MachineStatus: {
      keyFields: ["id"],
      fields: {
        /**
         * Subscription payloads carry the machine's current alerts, which
         * would otherwise replace the cached list wholesale. Merging by id
         * keeps alerts that are not in the incoming payload.
         */
        alerts: {
          merge(
            existing: readonly CachedAlert[] = [],
            incoming: readonly CachedAlert[],
            { readField }
          ) {
            const byId = new Map<string, CachedAlert>();
            for (const alert of [...existing, ...incoming]) {
              const id = readField<string>("id", alert);
              if (id) byId.set(id, alert);
            }
            return [...byId.values()];
          },
        },
      },
    },
  },
});

export const apolloClient = new ApolloClient({
  link: from([errorLink, splitLink]),
  cache,
  defaultOptions: {
    // Render whatever is cached immediately, then refresh from the network.
    watchQuery: { fetchPolicy: "cache-and-network" },
  },
});
