import assert from "node:assert/strict";
import test from "node:test";
import type { PluginCommandContext } from "openclaw/plugin-sdk/core";
import { ArrApiError, type ArrClient, type RequestResult } from "./arr-client.js";
import { DENIED_RESPONSE, ViktorMediaController } from "./controller.js";

function commandContext(overrides: Partial<PluginCommandContext> = {}): PluginCommandContext {
  return {
    channel: "telegram",
    from: "telegram:123",
    to: "telegram:123",
    senderId: "123",
    isAuthorizedSender: true,
    args: "Arrival 2016",
    ...overrides,
  } as PluginCommandContext;
}

function controller(result: RequestResult | Error) {
  return new ViktorMediaController({
    async request() {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  } as ArrClient);
}

void test("authorized movie and show commands return deterministic backend results", async () => {
  const added = controller({ status: "added", title: "Arrival (2016)", searchAccepted: true });
  assert.equal(
    (await added.handle("movie", commandContext())).text,
    "Arrival (2016) added to Radarr; search accepted.",
  );
  assert.equal(
    (await added.handle("show", commandContext({ args: "Severance 2022" }))).text,
    "Arrival (2016) added to Sonarr; search accepted.",
  );
});

void test("unauthorized execution returns the media denial before any backend call", async () => {
  let calls = 0;
  const media = new ViktorMediaController({
    async request() {
      calls += 1;
      return { status: "no-result" } as const;
    },
  } as ArrClient);

  const result = await media.handle("movie", commandContext({ isAuthorizedSender: false }));
  assert.equal(result.text, DENIED_RESPONSE);
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});

void test("commands require a private Telegram DM whose chat matches the sender", async () => {
  const media = controller({ status: "no-result" });
  for (const context of [
    commandContext({ from: "telegram:group:-1001", to: "telegram:-1001" }),
    commandContext({ from: "telegram:123", to: "telegram:456" }),
    commandContext({ channel: "discord" }),
  ]) {
    assert.equal(
      (await media.handle("movie", context)).text,
      "Use /movie in a direct Telegram chat with Viktor.",
    );
  }
});

void test("choice, existing, and failed-search responses stay concise and accurate", async () => {
  assert.equal(
    (
      await controller({
        status: "choices",
        choices: [
          { title: "Saved!", year: 2004 },
          { title: "Saved", year: 2009 },
        ],
      }).handle("movie", commandContext({ args: "Saved" }))
    ).text,
    "I could not identify one confident match. 1. Saved! (2004); 2. Saved (2009). Rerun /movie <exact title> <year>.",
  );
  assert.equal(
    (
      await controller({
        status: "already-managed",
        title: "Arrival (2016)",
        unmonitored: true,
      }).handle("movie", commandContext())
    ).text,
    "Arrival (2016) is already in Radarr, but it is not monitored.",
  );
  assert.equal(
    (
      await controller({
        status: "added",
        title: "Arrival (2016)",
        searchAccepted: false,
      }).handle("movie", commandContext())
    ).text,
    "Arrival (2016) added to Radarr, but search could not be started.",
  );
});

void test("authentication, backend, and rejection failures have bounded responses", async () => {
  for (const [kind, expected] of [
    ["authentication", "Radarr authentication needs owner attention."],
    ["backend-unavailable", "Radarr is unavailable right now. Try again later."],
    ["rejected", "Radarr rejected that request."],
  ] as const) {
    const result = await controller(new ArrApiError("Radarr", kind, null)).handle(
      "movie",
      commandContext(),
    );
    assert.equal(result.text, expected);
    assert.equal(result.isError, true);
  }
});
