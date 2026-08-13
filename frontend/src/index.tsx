import React from "react";
import ReactDOM from "react-dom/client";
import { ApolloProvider } from "@apollo/client";
import { apolloClient } from "./apolloClient";
import App from "./App";
import "./styles.css";

// Handy for poking at the cache from the browser console during development.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__APOLLO_CLIENT__ = apolloClient;
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

root.render(
  <React.StrictMode>
    <ApolloProvider client={apolloClient}>
      <App />
    </ApolloProvider>
  </React.StrictMode>
);
