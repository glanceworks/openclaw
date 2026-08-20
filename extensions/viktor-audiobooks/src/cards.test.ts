import assert from "node:assert/strict";
import test from "node:test";

import { renderCard } from "./cards.js";
import type { KeyedStore } from "./state.js";
import type { BookRequest, CallbackIntent, CandidateSet } from "./types.js";

class MemoryStore<T> implements KeyedStore<T> {
  readonly values = new Map<string, T>();
  async register(key: string, value: T): Promise<void> { this.values.set(key, value); }
  async registerIfAbsent(key: string, value: T): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }
  async lookup(key: string): Promise<T | undefined> { return this.values.get(key); }
  async consume(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    this.values.delete(key);
    return value;
  }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async entries(): Promise<Array<{ key: string; value: T }>> {
    return [...this.values].map(([key, value]) => ({ key, value }));
  }
}

function request(cancelAllowed: boolean): BookRequest {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Safe Book",
    author: "Safe Author",
    status: "waiting_user",
    status_label: "Waiting for user",
    created_at: "2026-08-18T00:00:00Z",
    updated_at: "2026-08-18T00:00:01Z",
    cancel_allowed: cancelAllowed,
    job: {
      stage: "select_release",
      stage_label: "Select release",
      status: "waiting_user",
      status_label: "Waiting for user",
      in_progress: false,
      user_action: "select_release_in_web",
      updated_at: "2026-08-18T00:00:01Z",
    },
  };
}

test("selected release gets a separate Get button and cancellation follows the server field", async () => {
  const callbacks = new MemoryStore<CallbackIntent>();
  const candidates: CandidateSet = {
    request_id: request(true).id,
    kind: "release",
    candidates: [
      { id: 1, title: "Edition One", selected: true },
      { id: 2, title: "Edition Two", selected: false },
    ],
  };
  const card = await renderCard({
    request: request(true),
    candidates,
    actor: `v1.${"A".repeat(43)}`,
    route: { chatId: "123" },
    messageId: 10,
    callbacks,
  });

  const labels = card.buttons.flat().map((button) => button.text);
  assert(labels.includes("Get this book"));
  assert(labels.includes("Cancel this request"));
  assert.equal(
    [...callbacks.values.values()].find((intent) => intent.action === "authorize")?.candidateId,
    1,
  );
  for (const button of card.buttons.flat()) {
    assert.match(button.callback_data, /^vab:[A-Za-z0-9_-]{24}$/u);
  }
  for (const intent of callbacks.values.values()) {
    assert.equal(intent.actor, `v1.${"A".repeat(43)}`);
    assert.equal(intent.requestId, request(true).id);
    assert.equal(intent.messageId, 10);
    assert.equal(intent.requestFingerprint, "11111111-1111-4111-8111-111111111111|waiting_user|2026-08-18T00:00:01Z|select_release|waiting_user|2026-08-18T00:00:01Z");
  }

  const withoutCancel = await renderCard({
    request: request(false),
    candidates,
    actor: `v1.${"A".repeat(43)}`,
    route: { chatId: "123" },
    messageId: 11,
    callbacks: new MemoryStore<CallbackIntent>(),
  });
  assert.equal(withoutCancel.buttons.flat().some((button) => button.text.includes("Cancel")), false);
});

test("web-only states produce only a generic owner handoff", async () => {
  const webOnly = request(false);
  if (!webOnly.job) throw new Error("test request must have a job");
  webOnly.job.stage = "validate_media";
  webOnly.job.stage_label = "Validate media";
  webOnly.job.user_action = "inspect_unsupported_files_in_web";
  const card = await renderCard({
    request: webOnly,
    actor: `v1.${"A".repeat(43)}`,
    route: { chatId: "123" },
    messageId: 12,
    callbacks: new MemoryStore<CallbackIntent>(),
  });

  assert.match(card.text, /Owner action required in Audiobook Automation\./u);
  assert.equal(card.text.includes(webOnly.job.user_action), false);
  assert.equal(card.buttons.length, 0);
});

test("Telegram cards replace downstream labels and candidate sources with app abstractions", async () => {
  const redacted = request(false);
  if (!redacted.job) throw new Error("test request must have a job");
  redacted.status_label = "Waiting on a private host";
  redacted.job.stage = "monitor_sab";
  redacted.job.stage_label = "Monitor downstream downloader";
  redacted.job.status = "waiting_external";
  redacted.job.status_label = "Waiting on downstream storage";
  redacted.job.user_action = null;
  const sourceLeakingCandidate = {
    id: 7,
    indexer: "Private indexer name",
    provider: "Private provider name",
    size_bytes: 1_048_576,
    selected: false,
  } as CandidateSet["candidates"][number] & { indexer: string; provider: string };
  const candidates: CandidateSet = {
    request_id: redacted.id,
    kind: "nzb",
    candidates: [sourceLeakingCandidate],
  };

  const card = await renderCard({
    request: redacted,
    candidates,
    actor: `v1.${"A".repeat(43)}`,
    route: { chatId: "123" },
    messageId: 13,
    callbacks: new MemoryStore<CallbackIntent>(),
  });

  assert.match(card.text, /Step: Downloading/u);
  assert.match(card.text, /Progress: Waiting/u);
  assert.equal(card.text.includes("private host"), false);
  assert.equal(card.text.includes("downstream"), false);
  assert.equal(card.buttons[0]?.[0]?.text, "Exact match 1 — 1 MB");
  assert.equal(card.buttons.flat().some((button) => button.text.includes("Private")), false);
});
