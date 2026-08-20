import assert from "node:assert/strict";
import test from "node:test";

import { deriveActor } from "./actor.js";

test("actor derivation is stable, versioned, opaque, and sender-specific", () => {
  const secret = "a-long-lived-identity-secret-with-enough-entropy";
  const first = deriveActor(secret, "123456789");
  const replay = deriveActor(secret, "123456789");
  const other = deriveActor(secret, "987654321");

  assert.equal(first, replay);
  assert.notEqual(first, other);
  assert.match(first, /^v1\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(first.includes("123456789"), false);
});
