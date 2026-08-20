import assert from "node:assert/strict";
import test from "node:test";

import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

import { ownerToolRoute } from "./index.js";

test("natural-language create route exists only for the current Telegram owner", () => {
  const base = {
    messageChannel: "telegram",
    requesterSenderId: "123",
    deliveryContext: { channel: "telegram", to: "telegram:123" },
  };

  assert.equal(
    ownerToolRoute({ ...base, senderIsOwner: false } as OpenClawPluginToolContext),
    null,
  );
  assert.deepEqual(
    ownerToolRoute({ ...base, senderIsOwner: true } as OpenClawPluginToolContext),
    { chatId: "123" },
  );
});

test("owner natural-language create route rejects groups and non-Telegram delivery", () => {
  const owner = {
    messageChannel: "telegram",
    requesterSenderId: "123",
    senderIsOwner: true,
  };

  assert.equal(
    ownerToolRoute({
      ...owner,
      deliveryContext: { channel: "telegram", to: "telegram:-100123" },
    } as OpenClawPluginToolContext),
    null,
  );
  assert.equal(
    ownerToolRoute({
      ...owner,
      deliveryContext: { channel: "webchat", to: "123" },
    } as OpenClawPluginToolContext),
    null,
  );
  assert.equal(
    ownerToolRoute({
      ...owner,
      deliveryContext: { channel: "telegram", to: "telegram:456" },
    } as OpenClawPluginToolContext),
    null,
  );
});
