import test from "node:test";
import assert from "node:assert/strict";

import { isMachineSubscribed } from "../lib/subscriptions.js";

test("a subscriber with no machineId receives every machine", () => {
  assert.equal(isMachineSubscribed("M-001"), true);
  assert.equal(isMachineSubscribed("M-001", null), true);
});

test("a subscriber with a machineId receives that machine", () => {
  assert.equal(isMachineSubscribed("M-001", "M-001"), true);
});

test("a subscriber with a machineId does not receive other machines", () => {
  assert.equal(isMachineSubscribed("M-001", "M-002"), false);
});
