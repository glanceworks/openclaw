import assert from "node:assert/strict";
import test from "node:test";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { deriveActor } from "./actor.js";
import { ApplicationApi } from "./api-client.js";
import { requestFingerprint } from "./cards.js";
import {
  ViktorAudiobookController,
  callbackMatchesIntent,
  directTelegramRoute,
  parseBookCommand,
} from "./controller.js";
import type { KeyedStore, PluginStores } from "./state.js";
import type {
  BookRequest,
  CallbackIntent,
  CandidateSet,
  CreateIntent,
  PluginConfig,
  RequestBinding,
} from "./types.js";

const actorA = `v1.${"A".repeat(43)}`;
const actorB = `v1.${"B".repeat(43)}`;

const mediaAccessConfig = {
  accessGroups: {
    "viktor-media-users": {
      type: "message.senders",
      members: { telegram: ["7339717357", "8948449336"] },
    },
  },
} satisfies OpenClawConfig;

const actorDerivationSecret = "long-lived-test-identity-secret-value";

class MemoryStore<T> implements KeyedStore<T> {
  readonly values = new Map<string, T>();
  async register(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
  async registerIfAbsent(key: string, value: T): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }
  async lookup(key: string): Promise<T | undefined> {
    return this.values.get(key);
  }
  async consume(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    this.values.delete(key);
    return value;
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  async entries(): Promise<Array<{ key: string; value: T }>> {
    return [...this.values].map(([key, value]) => ({ key, value }));
  }
}

class FiniteTimestampStore extends MemoryStore<RequestBinding> {
  override async register(key: string, value: RequestBinding): Promise<void> {
    assert(Number.isFinite(value.nextPollAt), "nextPollAt must be finite");
    await super.register(key, value);
  }
}

function intent(requestId: string, messageId: number): CallbackIntent {
  return {
    token: `token-${requestId}`,
    actor: actorA,
    requestId,
    action: "select_release",
    candidateId: 1,
    route: { chatId: "123" },
    messageId,
    requestFingerprint: `revision-${requestId}`,
    idempotencyKey: `idempotency-${requestId}`,
    createdAt: 1,
  };
}

test("book command parsing keeps cancel non-mutating and request creation explicit", () => {
  assert.deepEqual(parseBookCommand("status"), { kind: "status" });
  assert.deepEqual(parseBookCommand("cancel"), { kind: "cancel" });
  assert.deepEqual(parseBookCommand("Dune by Frank Herbert"), {
    kind: "create",
    title: "Dune",
    author: "Frank Herbert",
  });
});

test("direct-message route rejects group-shaped Telegram origins", () => {
  const direct = directTelegramRoute({
    channel: "telegram",
    from: "telegram:123",
    to: "telegram:123",
    senderId: "123",
  } as PluginCommandContext);
  const group = directTelegramRoute({
    channel: "telegram",
    from: "telegram:group:-1001",
    to: "telegram:-1001",
    senderId: "123",
  } as PluginCommandContext);
  const mismatchedSender = directTelegramRoute({
    channel: "telegram",
    from: "telegram:123",
    to: "telegram:123",
    senderId: "456",
  } as PluginCommandContext);

  assert.deepEqual(direct, { chatId: "123" });
  assert.equal(group, null);
  assert.equal(mismatchedSender, null);
});

test("one actor's concurrent request cards cannot cross callbacks", () => {
  const first = intent("request-1", 11);
  const second = intent("request-2", 22);

  assert(callbackMatchesIntent({ intent: first, actor: actorA, chatId: "123", messageId: 11 }));
  assert(callbackMatchesIntent({ intent: second, actor: actorA, chatId: "123", messageId: 22 }));
  assert.equal(
    callbackMatchesIntent({ intent: first, actor: actorA, chatId: "123", messageId: 22 }),
    false,
  );
  assert.equal(
    callbackMatchesIntent({ intent: first, actor: actorB, chatId: "123", messageId: 11 }),
    false,
  );
  assert.equal(
    callbackMatchesIntent({ intent: first, actor: actorA, chatId: "456", messageId: 11 }),
    false,
  );
  const threaded = { ...first, route: { chatId: "123", threadId: 7 } };
  assert(
    callbackMatchesIntent({
      intent: threaded,
      actor: actorA,
      chatId: "123",
      messageId: 11,
      threadId: 7,
    }),
  );
  assert.equal(
    callbackMatchesIntent({
      intent: threaded,
      actor: actorA,
      chatId: "123",
      messageId: 11,
      threadId: 8,
    }),
    false,
  );
});

test("rights revocation rejects an old callback without touching Django", async () => {
  let applicationCalls = 0;
  let reply = "";
  const application = {
    status: async () => {
      applicationCalls += 1;
      throw new Error("must not run");
    },
    control: async () => {
      applicationCalls += 1;
      throw new Error("must not run");
    },
  } as unknown as ApplicationApi;
  const controller = new ViktorAudiobookController(
    { logger: { warn() {}, error() {} } } as unknown as OpenClawPluginApi,
    {
      applicationBaseUrl: "https://private.invalid/",
      tailnetOnlyHttp: false,
      createReadToken: "create-read-token-not-a-real-secret",
      controlToken: "control-token-not-a-real-secret",
      actorDerivationSecret: "long-lived-test-identity-secret-value",
      ownerToolEnabled: true,
    },
    application,
    {} as PluginStores,
  );

  await controller.handleCallback({
    senderId: "123",
    accountId: "default",
    isGroup: false,
    auth: { isAuthorizedSender: false },
    callback: { payload: "old", messageId: 11, chatId: "123" },
    respond: {
      async reply(params) {
        reply = params.text;
      },
      async editMessage() {
        throw new Error("must not edit");
      },
    },
  });

  assert.equal(applicationCalls, 0);
  assert.equal(reply, "This action is not authorized.");
});

test("rights revocation rejects future book commands without touching Django", async () => {
  let applicationCalls = 0;
  const controller = new ViktorAudiobookController(
    { logger: { warn() {}, error() {} } } as unknown as OpenClawPluginApi,
    {
      applicationBaseUrl: "https://private.invalid/",
      tailnetOnlyHttp: false,
      createReadToken: "create-read-token-not-a-real-secret",
      controlToken: "control-token-not-a-real-secret",
      actorDerivationSecret: "long-lived-test-identity-secret-value",
      ownerToolEnabled: true,
    },
    {
      async create() {
        applicationCalls += 1;
        throw new Error("must not create");
      },
    } as unknown as ApplicationApi,
    {} as PluginStores,
  );

  const result = await controller.handleBookCommand({
    channel: "telegram",
    from: "telegram:123",
    to: "telegram:123",
    senderId: "123",
    isAuthorizedSender: false,
    args: "Safe Book",
  } as PluginCommandContext);

  assert.equal(applicationCalls, 0);
  assert.equal(result.isError, true);
});

test("Jamie, Michelle, and Brittany can use book without widening canonical access", async () => {
  let applicationCalls = 0;
  const stores = {
    creates: new MemoryStore<CreateIntent>(),
    bindings: new MemoryStore<RequestBinding>(),
    callbacks: new MemoryStore<CallbackIntent>(),
    leases: new MemoryStore<{ owner: string; createdAt: number }>(),
  } satisfies PluginStores;
  const controller = new ViktorAudiobookController(
    {
      config: mediaAccessConfig,
      logger: { warn() {}, error() {} },
    } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async create() {
        applicationCalls += 1;
        throw new Error("must not create for status or denied commands");
      },
    } as unknown as ApplicationApi,
    stores,
  );

  for (const user of [
    { id: "7426409164", canonical: true },
    { id: "7339717357", canonical: false },
    { id: "8948449336", canonical: false },
  ]) {
    const result = await controller.handleBookCommand({
      channel: "telegram",
      from: `telegram:${user.id}`,
      to: `telegram:${user.id}`,
      senderId: user.id,
      isAuthorizedSender: user.canonical,
      args: "status",
    } as PluginCommandContext);
    assert.match(result.text ?? "", /^Refreshed 0 active audiobook request cards\./u);
  }

  const unknownId = "8707567979";
  const denied = await controller.handleBookCommand({
    channel: "telegram",
    from: `telegram:${unknownId}`,
    to: `telegram:${unknownId}`,
    senderId: unknownId,
    isAuthorizedSender: false,
    args: "Safe Book",
  } as PluginCommandContext);
  assert.equal(denied.isError, true);
  assert.equal(applicationCalls, 0);
});

test("one media user cannot act on another media user's audiobook callback", async () => {
  let applicationCalls = 0;
  let reply = "";
  const callbacks = new MemoryStore<CallbackIntent>();
  const brittanyId = "8948449336";
  await callbacks.register("michelle-request", {
    token: "michelle-request",
    actor: deriveActor(actorDerivationSecret, "7339717357"),
    requestId: "request-1",
    action: "cancel",
    route: { chatId: brittanyId },
    messageId: 11,
    requestFingerprint: "revision-1",
    idempotencyKey: "idempotency-1",
    createdAt: 1,
  });
  const controller = new ViktorAudiobookController(
    {
      config: mediaAccessConfig,
      logger: { warn() {}, error() {} },
    } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        applicationCalls += 1;
        throw new Error("must not load another actor's request");
      },
    } as unknown as ApplicationApi,
    {
      callbacks,
      creates: new MemoryStore<CreateIntent>(),
      bindings: new MemoryStore<RequestBinding>(),
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );

  await controller.handleCallback({
    senderId: brittanyId,
    accountId: "default",
    isGroup: false,
    auth: { isAuthorizedSender: false },
    callback: { payload: "michelle-request", messageId: 11, chatId: brittanyId },
    respond: {
      async reply(params) {
        reply = params.text;
      },
      async editMessage() {
        throw new Error("must not edit another actor's request");
      },
    },
  });

  assert.equal(applicationCalls, 0);
  assert.equal(reply, "That button is expired or belongs to another request.");
});

test("media-user callbacks still require sender and private chat equality", async () => {
  let callbackLookups = 0;
  let reply = "";
  const controller = new ViktorAudiobookController(
    {
      config: mediaAccessConfig,
      logger: { warn() {}, error() {} },
    } as unknown as OpenClawPluginApi,
    testConfig,
    {} as ApplicationApi,
    {
      callbacks: {
        async lookup() {
          callbackLookups += 1;
          return undefined;
        },
      },
    } as unknown as PluginStores,
  );

  await controller.handleCallback({
    senderId: "7339717357",
    accountId: "default",
    isGroup: false,
    auth: { isAuthorizedSender: false },
    callback: { payload: "token", messageId: 11, chatId: "8948449336" },
    respond: {
      async reply(params) {
        reply = params.text;
      },
      async editMessage() {},
    },
  });

  assert.equal(callbackLookups, 0);
  assert.equal(reply, "This action is not authorized.");
});

test("book cancel refreshes bindings without calling a cancellation control", async () => {
  let controlCalls = 0;
  const bindings = new MemoryStore<RequestBinding>();
  const stores = {
    creates: new MemoryStore<CreateIntent>(),
    bindings,
    callbacks: new MemoryStore<CallbackIntent>(),
    leases: new MemoryStore<{ owner: string; createdAt: number }>(),
  } satisfies PluginStores;
  const controller = new ViktorAudiobookController(
    { logger: { warn() {}, error() {} } } as unknown as OpenClawPluginApi,
    {
      applicationBaseUrl: "https://private.invalid/",
      tailnetOnlyHttp: false,
      createReadToken: "create-read-token-not-a-real-secret",
      controlToken: "control-token-not-a-real-secret",
      actorDerivationSecret: "long-lived-test-identity-secret-value",
      ownerToolEnabled: true,
    },
    {
      async control() {
        controlCalls += 1;
        throw new Error("must not cancel");
      },
    } as unknown as ApplicationApi,
    stores,
  );

  const result = await controller.handleBookCommand({
    channel: "telegram",
    from: "telegram:123",
    to: "telegram:123",
    senderId: "123",
    isAuthorizedSender: true,
    args: "cancel",
  } as PluginCommandContext);

  assert.equal(controlCalls, 0);
  assert.match(result.text ?? "", /request-specific Cancel button/u);
});

test("ambiguous card delivery is never resent automatically", async () => {
  let applicationCalls = 0;
  let errors = 0;
  const creates = new MemoryStore<CreateIntent>();
  await creates.register("create-1", {
    idempotencyKey: "create-1",
    actor: actorA,
    title: "Safe Book",
    author: "Safe Author",
    route: { chatId: "123" },
    requestId: "request-1",
    cardDeliveryStartedAt: 10,
    createdAt: 1,
  });
  const stores = {
    creates,
    bindings: new MemoryStore<RequestBinding>(),
    callbacks: new MemoryStore<CallbackIntent>(),
    leases: new MemoryStore<{ owner: string; createdAt: number }>(),
  } satisfies PluginStores;
  const controller = new ViktorAudiobookController(
    {
      logger: {
        warn() {},
        error() {
          errors += 1;
        },
      },
    } as unknown as OpenClawPluginApi,
    {
      applicationBaseUrl: "https://private.invalid/",
      tailnetOnlyHttp: false,
      createReadToken: "create-read-token-not-a-real-secret",
      controlToken: "control-token-not-a-real-secret",
      actorDerivationSecret: "long-lived-test-identity-secret-value",
      ownerToolEnabled: true,
    },
    {
      async create() {
        applicationCalls += 1;
        throw new Error("must not create");
      },
      async status() {
        applicationCalls += 1;
        throw new Error("must not refresh");
      },
    } as unknown as ApplicationApi,
    stores,
  );

  await (controller as unknown as { recoverCreateIntents(): Promise<void> }).recoverCreateIntents();
  await (controller as unknown as { recoverCreateIntents(): Promise<void> }).recoverCreateIntents();

  assert.equal(applicationCalls, 0);
  assert.equal(errors, 1);
  assert.equal(typeof (await creates.lookup("create-1"))?.cardDeliveryUncertainAt, "number");
});

test("ambiguous terminal notification is recorded before send and not retried", async () => {
  let sends = 0;
  let notificationText = "";
  const terminalRequest: BookRequest = {
    id: "request-1",
    title: "Safe Book",
    author: "Safe Author",
    selected_edition: null,
    status: "completed",
    status_label: "Completed through a private downstream service",
    created_at: "2026-08-18T00:00:00Z",
    updated_at: "2026-08-18T00:00:01Z",
    cancel_allowed: false,
    job: null,
  };
  const binding: RequestBinding = {
    requestId: terminalRequest.id,
    actor: actorA,
    route: { chatId: "123" },
    messageId: 11,
    fingerprint: requestFingerprint(terminalRequest),
    nextPollAt: 0,
    failureCount: 0,
    terminal: false,
    terminalNotified: false,
    createdAt: 1,
  };
  const bindings = new MemoryStore<RequestBinding>();
  await bindings.register(binding.requestId, binding);
  const stores = {
    creates: new MemoryStore<CreateIntent>(),
    bindings,
    callbacks: new MemoryStore<CallbackIntent>(),
    leases: new MemoryStore<{ owner: string; createdAt: number }>(),
  } satisfies PluginStores;
  const controller = new ViktorAudiobookController(
    {
      config: {},
      logger: { warn() {}, error() {} },
      runtime: {
        channel: {
          outbound: {
            async loadAdapter() {
              return {
                async sendText(message: { text: string }) {
                  sends += 1;
                  notificationText = message.text;
                  throw new Error("ambiguous Telegram failure");
                },
              };
            },
          },
        },
      },
    } as unknown as OpenClawPluginApi,
    {
      applicationBaseUrl: "https://private.invalid/",
      tailnetOnlyHttp: false,
      createReadToken: "create-read-token-not-a-real-secret",
      controlToken: "control-token-not-a-real-secret",
      actorDerivationSecret: "long-lived-test-identity-secret-value",
      ownerToolEnabled: true,
    },
    {
      async status() {
        return terminalRequest;
      },
    } as unknown as ApplicationApi,
    stores,
  );

  const poll = (value: RequestBinding) =>
    (controller as unknown as { pollBinding(binding: RequestBinding): Promise<void> }).pollBinding(
      value,
    );
  await poll(binding);
  const recorded = await bindings.lookup(binding.requestId);
  assert.equal(typeof recorded?.terminalNotificationStartedAt, "number");
  assert.equal(recorded?.terminal, true);
  assert.equal(recorded?.terminalNotified, false);
  if (!recorded) throw new Error("binding was not recorded");
  await poll(recorded);
  assert.equal(sends, 1);
  assert.equal(notificationText, "Safe Book: Completed.");
});

const testConfig: PluginConfig = {
  applicationBaseUrl: "https://private.invalid/",
  tailnetOnlyHttp: false,
  createReadToken: "create-read-token-not-a-real-secret",
  controlToken: "control-token-not-a-real-secret",
  actorDerivationSecret: "long-lived-test-identity-secret-value",
  ownerToolEnabled: true,
};

function searchingRequest(): BookRequest {
  return {
    id: "request-refresh",
    title: "Onyx Storm",
    author: "Rebecca Yarros",
    selected_edition: null,
    status: "searching",
    status_label: "Searching",
    created_at: "2026-08-19T00:00:00Z",
    updated_at: "2026-08-19T00:00:01Z",
    cancel_allowed: false,
    job: {
      stage: "discover",
      stage_label: "Discover",
      status: "running",
      status_label: "Running",
      in_progress: true,
      user_action: null,
      updated_at: "2026-08-19T00:00:01Z",
    },
  };
}

function waitingRequest(cancelAllowed = true): BookRequest {
  return {
    ...searchingRequest(),
    status: "waiting_user",
    status_label: "Waiting for user",
    updated_at: "2026-08-19T00:00:02Z",
    cancel_allowed: cancelAllowed,
    job: {
      stage: "select_release",
      stage_label: "Select release",
      status: "waiting_user",
      status_label: "Waiting for user",
      in_progress: false,
      user_action: "select_release_in_web",
      updated_at: "2026-08-19T00:00:02Z",
    },
  };
}

function preflightRequest(): BookRequest {
  return {
    ...waitingRequest(false),
    selected_edition: {
      id: 17,
      title: "Onyx Storm",
      author: "Rebecca Yarros",
      year: "2025",
      series: "The Empyrean #3",
    },
    status: "in_progress",
    status_label: "In progress",
    updated_at: "2026-08-19T00:00:03Z",
    job: {
      stage: "preflight_library",
      stage_label: "Preflight library",
      status: "pending",
      status_label: "Pending",
      in_progress: false,
      user_action: null,
      updated_at: "2026-08-19T00:00:03Z",
    },
  };
}

test("release acquisition uses the control token and callback idempotency key", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const request = preflightRequest();
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify({ request }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const createReadToken = "c".repeat(32);
  const controlToken = "d".repeat(32);
  const api = new ApplicationApi(
    "https://audiobooks.internal/",
    createReadToken,
    controlToken,
    false,
  );

  const result = await api.releaseAcquisition(actorA, request.id, 17, "stable-callback-key");

  assert.equal(
    requestedUrl,
    `https://audiobooks.internal/api/v1/requests/${request.id}/release-selection/`,
  );
  assert.equal(requestedInit?.method, "POST");
  const headers = new Headers(requestedInit?.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${controlToken}`);
  assert.equal(headers.get("X-Viktor-Actor"), actorA);
  assert.equal(headers.get("Idempotency-Key"), "stable-callback-key");
  assert.equal(requestedInit?.body, JSON.stringify({ candidate_id: 17 }));
  assert.deepEqual(result.selected_edition, request.selected_edition);
});

const releaseCandidates: CandidateSet = {
  request_id: "request-refresh",
  kind: "release",
  candidates: [
    { id: 17, title: "Onyx Storm edition", selected: false },
    { id: 18, title: "Selected edition", selected: true },
  ],
};

test("edition callback acquires immediately and consumes only after API success", async () => {
  const senderId = "123";
  const actor = deriveActor(testConfig.actorDerivationSecret, senderId);
  const waiting = waitingRequest();
  const callbacks = new MemoryStore<CallbackIntent>();
  await callbacks.register("acquire-token", {
    token: "acquire-token",
    actor,
    requestId: waiting.id,
    action: "acquire_release",
    candidateId: 17,
    route: { chatId: senderId },
    messageId: 52,
    requestFingerprint: requestFingerprint(waiting),
    idempotencyKey: "acquire-idempotency",
    createdAt: 1,
  });
  let acquisition:
    | { actor: string; requestId: string; candidateId: number; idempotencyKey: string }
    | undefined;
  let controlCalls = 0;
  let edited = "";
  const controller = new ViktorAudiobookController(
    { logger: { warn() {}, error() {} } } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        return waiting;
      },
      async releaseAcquisition(
        callbackActor: string,
        requestId: string,
        candidateId: number,
        idempotencyKey: string,
      ) {
        acquisition = { actor: callbackActor, requestId, candidateId, idempotencyKey };
        assert(await callbacks.lookup("acquire-token"));
        return preflightRequest();
      },
      async control() {
        controlCalls += 1;
        throw new Error("must not use a legacy control");
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings: new MemoryStore<RequestBinding>(),
      callbacks,
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );

  await controller.handleCallback({
    senderId,
    accountId: "default",
    isGroup: false,
    auth: { isAuthorizedSender: true },
    callback: { payload: "acquire-token", messageId: 52, chatId: senderId },
    respond: {
      async reply() {
        throw new Error("must not reply");
      },
      async editMessage(params) {
        edited = params.text;
      },
    },
  });

  assert.deepEqual(acquisition, {
    actor,
    requestId: waiting.id,
    candidateId: 17,
    idempotencyKey: "acquire-idempotency",
  });
  assert.equal(controlCalls, 0);
  assert.equal(await callbacks.lookup("acquire-token"), undefined);
  assert.match(edited, /Selected edition:\n\nOnyx Storm\nRebecca Yarros\n2025/u);
  assert.match(edited, /Status:\nChecking your library/u);
});

test("edition callback retry keeps its idempotency key and duplicate success is harmless", async () => {
  const senderId = "123";
  const actor = deriveActor(testConfig.actorDerivationSecret, senderId);
  const waiting = waitingRequest();
  const callbacks = new MemoryStore<CallbackIntent>();
  await callbacks.register("retry-token", {
    token: "retry-token",
    actor,
    requestId: waiting.id,
    action: "acquire_release",
    candidateId: 17,
    route: { chatId: senderId },
    messageId: 53,
    requestFingerprint: requestFingerprint(waiting),
    idempotencyKey: "stable-acquisition-key",
    createdAt: 1,
  });
  const idempotencyKeys: string[] = [];
  const replies: string[] = [];
  const controller = new ViktorAudiobookController(
    { logger: { warn() {}, error() {} } } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        return waiting;
      },
      async releaseAcquisition(
        _actor: string,
        _requestId: string,
        _candidateId: number,
        idempotencyKey: string,
      ) {
        idempotencyKeys.push(idempotencyKey);
        if (idempotencyKeys.length === 1) throw new Error("ambiguous response");
        return preflightRequest();
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings: new MemoryStore<RequestBinding>(),
      callbacks,
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );
  const click = () =>
    controller.handleCallback({
      senderId,
      accountId: "default",
      isGroup: false,
      auth: { isAuthorizedSender: true },
      callback: { payload: "retry-token", messageId: 53, chatId: senderId },
      respond: {
        async reply(params) {
          replies.push(params.text);
        },
        async editMessage() {},
      },
    });

  await click();
  assert(await callbacks.lookup("retry-token"));
  await click();
  assert.equal(await callbacks.lookup("retry-token"), undefined);
  await click();

  assert.deepEqual(idempotencyKeys, ["stable-acquisition-key", "stable-acquisition-key"]);
  assert.equal(replies.length, 2);
  assert.match(replies[1] ?? "", /expired or belongs to another request/u);
});

test("stale edition and cancel callbacks persist a finite terminal poll timestamp", async () => {
  const senderId = "123";
  const actor = deriveActor(testConfig.actorDerivationSecret, senderId);
  const waiting = waitingRequest();
  const terminal: BookRequest = {
    ...waiting,
    status: "canceled",
    status_label: "Canceled",
    updated_at: "2026-08-19T00:00:04Z",
    cancel_allowed: false,
    job: null,
  };
  const callbacks = new MemoryStore<CallbackIntent>();
  const callbackCases = [
    { token: "edition-terminal-token", action: "acquire_release" as const, candidateId: 17 },
    { token: "cancel-terminal-token", action: "cancel" as const },
  ];
  for (const { token, action, ...candidate } of callbackCases) {
    await callbacks.register(token, {
      token,
      actor,
      requestId: waiting.id,
      action,
      ...candidate,
      route: { chatId: senderId },
      messageId: 54,
      requestFingerprint: requestFingerprint(waiting),
      idempotencyKey: `${action}-terminal-key`,
      createdAt: 1,
    });
  }
  const bindings = new FiniteTimestampStore();
  await bindings.register(waiting.id, {
    requestId: waiting.id,
    actor,
    route: { chatId: senderId },
    messageId: 54,
    fingerprint: requestFingerprint(waiting),
    nextPollAt: 0,
    failureCount: 0,
    terminal: false,
    terminalNotified: false,
    createdAt: 1,
  });
  let mutationCalls = 0;
  let edits = 0;
  const replies: string[] = [];
  const controller = new ViktorAudiobookController(
    { logger: { warn() {}, error() {} } } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        return terminal;
      },
      async releaseAcquisition() {
        mutationCalls += 1;
        throw new Error("must not acquire a terminal request");
      },
      async control() {
        mutationCalls += 1;
        throw new Error("must not cancel a terminal request");
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings,
      callbacks,
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );

  for (const { token } of callbackCases) {
    await controller.handleCallback({
      senderId,
      accountId: "default",
      isGroup: false,
      auth: { isAuthorizedSender: true },
      callback: { payload: token, messageId: 54, chatId: senderId },
      respond: {
        async reply(params) {
          replies.push(params.text);
        },
        async editMessage() {
          edits += 1;
        },
      },
    });
  }

  assert.equal(mutationCalls, 0);
  assert.equal(edits, 2);
  assert.deepEqual(replies, []);
  for (const { token } of callbackCases) {
    assert(await callbacks.lookup(token));
  }
  const binding = await bindings.lookup(waiting.id);
  assert.equal(binding?.terminal, true);
  assert.equal(binding?.nextPollAt, Number.MAX_SAFE_INTEGER);
});

test("wrong callback actor, chat, message, or thread never reaches the API", async () => {
  const senderId = "123";
  const actor = deriveActor(testConfig.actorDerivationSecret, senderId);
  const waiting = waitingRequest();
  const callbacks = new MemoryStore<CallbackIntent>();
  await callbacks.register("bound-token", {
    token: "bound-token",
    actor,
    requestId: waiting.id,
    action: "acquire_release",
    candidateId: 17,
    route: { chatId: senderId, threadId: 7 },
    messageId: 54,
    requestFingerprint: requestFingerprint(waiting),
    idempotencyKey: "bound-key",
    createdAt: 1,
  });
  let applicationCalls = 0;
  const controller = new ViktorAudiobookController(
    { logger: { warn() {}, error() {} } } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        applicationCalls += 1;
        throw new Error("must not read status");
      },
      async releaseAcquisition() {
        applicationCalls += 1;
        throw new Error("must not acquire");
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings: new MemoryStore<RequestBinding>(),
      callbacks,
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );
  const wrongBindings = [
    {
      senderId: "456",
      chatId: senderId,
      messageId: 54,
      threadId: 7,
      expected: /not authorized/u,
    },
    {
      senderId,
      chatId: "456",
      messageId: 54,
      threadId: 7,
      expected: /not authorized/u,
    },
    {
      senderId,
      chatId: senderId,
      messageId: 55,
      threadId: 7,
      expected: /expired or belongs to another request/u,
    },
    {
      senderId,
      chatId: senderId,
      messageId: 54,
      threadId: 8,
      expected: /expired or belongs to another request/u,
    },
  ];

  for (const callback of wrongBindings) {
    let reply = "";
    await controller.handleCallback({
      senderId: callback.senderId,
      accountId: "default",
      threadId: callback.threadId,
      isGroup: false,
      auth: { isAuthorizedSender: true },
      callback: {
        payload: "bound-token",
        messageId: callback.messageId,
        chatId: callback.chatId,
      },
      respond: {
        async reply(params) {
          reply = params.text;
        },
        async editMessage() {
          throw new Error("must not edit");
        },
      },
    });
    assert.match(reply, callback.expected);
  }

  assert.equal(applicationCalls, 0);
  assert(await callbacks.lookup("bound-token"));
});

test("stale legacy fingerprint refreshes safely without authorizing", async () => {
  const senderId = "123";
  const actor = deriveActor(testConfig.actorDerivationSecret, senderId);
  const waiting = waitingRequest();
  const callbacks = new MemoryStore<CallbackIntent>();
  await callbacks.register("stale-token", {
    token: "stale-token",
    actor,
    requestId: waiting.id,
    action: "authorize",
    candidateId: 17,
    route: { chatId: senderId },
    messageId: 56,
    requestFingerprint: "legacy-request-fingerprint",
    idempotencyKey: "legacy-key",
    createdAt: 1,
  });
  let mutationCalls = 0;
  let edits = 0;
  const controller = new ViktorAudiobookController(
    { logger: { warn() {}, error() {} } } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        return waiting;
      },
      async candidates() {
        return releaseCandidates;
      },
      async control() {
        mutationCalls += 1;
        throw new Error("must not authorize");
      },
      async releaseAcquisition() {
        mutationCalls += 1;
        throw new Error("must not acquire");
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings: new MemoryStore<RequestBinding>(),
      callbacks,
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );

  await controller.handleCallback({
    senderId,
    accountId: "default",
    isGroup: false,
    auth: { isAuthorizedSender: true },
    callback: { payload: "stale-token", messageId: 56, chatId: senderId },
    respond: {
      async reply() {
        throw new Error("must not reply");
      },
      async editMessage() {
        edits += 1;
      },
    },
  });

  assert.equal(mutationCalls, 0);
  assert.equal(edits, 1);
  assert(await callbacks.lookup("stale-token"));
});

test("legacy authorize callback keeps the separate reveal control", async () => {
  const senderId = "123";
  const actor = deriveActor(testConfig.actorDerivationSecret, senderId);
  const waiting = waitingRequest();
  const callbacks = new MemoryStore<CallbackIntent>();
  await callbacks.register("authorize-token", {
    token: "authorize-token",
    actor,
    requestId: waiting.id,
    action: "authorize",
    candidateId: 17,
    route: { chatId: senderId },
    messageId: 57,
    requestFingerprint: requestFingerprint(waiting),
    idempotencyKey: "authorize-key",
    createdAt: 1,
  });
  let legacyControl: string | undefined;
  let acquisitionCalls = 0;
  const controller = new ViktorAudiobookController(
    { logger: { warn() {}, error() {} } } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        return waiting;
      },
      async control(_actor: string, _requestId: string, action: string) {
        legacyControl = action;
        return preflightRequest();
      },
      async releaseAcquisition() {
        acquisitionCalls += 1;
        throw new Error("must not use release acquisition");
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings: new MemoryStore<RequestBinding>(),
      callbacks,
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );

  await controller.handleCallback({
    senderId,
    accountId: "default",
    isGroup: false,
    auth: { isAuthorizedSender: true },
    callback: { payload: "authorize-token", messageId: 57, chatId: senderId },
    respond: { async reply() {}, async editMessage() {} },
  });

  assert.equal(legacyControl, "reveal-authorization");
  assert.equal(acquisitionCalls, 0);
  assert.equal(await callbacks.lookup("authorize-token"), undefined);
});

test("poll refresh edits a searching card with portable waiting-user controls", async () => {
  const callbacks = new MemoryStore<CallbackIntent>();
  const bindings = new MemoryStore<RequestBinding>();
  const initial = searchingRequest();
  const binding: RequestBinding = {
    requestId: initial.id,
    actor: actorA,
    route: { chatId: "123", accountId: "default" },
    messageId: 41,
    fingerprint: requestFingerprint(initial),
    nextPollAt: 0,
    failureCount: 0,
    terminal: false,
    terminalNotified: false,
    createdAt: 1,
  };
  await bindings.register(binding.requestId, binding);
  let editMethod: string | undefined;
  let editRequest: Record<string, unknown> | undefined;
  const controller = new ViktorAudiobookController(
    {
      config: {},
      logger: { warn() {}, error() {} },
      runtime: {
        gateway: {
          async isAvailable() {
            return true;
          },
          async request(method: string, params: Record<string, unknown>) {
            editMethod = method;
            editRequest = params;
          },
        },
      },
    } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        return waitingRequest();
      },
      async candidates() {
        return releaseCandidates;
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings,
      callbacks,
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );

  const refreshed = await (
    controller as unknown as { pollBinding(value: RequestBinding): Promise<boolean> }
  ).pollBinding(binding);

  assert.equal(refreshed, true);
  assert.equal(editMethod, "message.action");
  assert.equal(editRequest?.channel, "telegram");
  assert.equal(editRequest?.action, "edit");
  assert.equal(editRequest?.accountId, "default");
  assert.match(String(editRequest?.idempotencyKey), /^viktor-audiobooks:request-card-edit:/u);
  const editParams = editRequest?.params as Record<string, unknown>;
  assert.match(String(editParams.content), /Status: Waiting for input/u);
  assert.match(String(editParams.content), /Step: Choose an edition/u);
  const interactive = editParams.interactive as {
    blocks: Array<{ type: string; buttons: Array<{ text: string; callback_data: string }> }>;
  };
  assert.equal(interactive.blocks[0]?.type, "buttons");
  assert.deepEqual(
    interactive.blocks[0]?.buttons.map((button) => button.text),
    ["Choose #1", "Choose #2", "Cancel this request"],
  );
  for (const button of interactive.blocks[0]?.buttons ?? []) {
    assert.match(button.callback_data, /^vab:[A-Za-z0-9_-]{24}$/u);
  }
  for (const callback of callbacks.values.values()) {
    assert.equal(callback.requestId, binding.requestId);
    assert.equal(callback.messageId, binding.messageId);
    assert.equal(callback.route.chatId, binding.route.chatId);
    assert.equal(callback.requestFingerprint, requestFingerprint(waitingRequest()));
  }
});

test("poll refresh rebuilds selected edition status from the API after restart", async () => {
  const bindings = new MemoryStore<RequestBinding>();
  const initial = searchingRequest();
  const binding: RequestBinding = {
    requestId: initial.id,
    actor: actorA,
    route: { chatId: "123" },
    messageId: 44,
    fingerprint: requestFingerprint(initial),
    nextPollAt: 0,
    failureCount: 0,
    terminal: false,
    terminalNotified: false,
    createdAt: 1,
  };
  await bindings.register(binding.requestId, binding);
  let editedText = "";
  let candidateCalls = 0;
  const controllerAfterRestart = new ViktorAudiobookController(
    {
      config: {},
      logger: { warn() {}, error() {} },
      runtime: {
        gateway: {
          async isAvailable() {
            return true;
          },
          async request(_method: string, request: Record<string, unknown>) {
            editedText = String((request.params as Record<string, unknown>).content);
          },
        },
      },
    } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        return preflightRequest();
      },
      async candidates() {
        candidateCalls += 1;
        throw new Error("selected edition must come from status");
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings,
      callbacks: new MemoryStore<CallbackIntent>(),
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );

  const refreshed = await (
    controllerAfterRestart as unknown as {
      pollBinding(value: RequestBinding): Promise<boolean>;
    }
  ).pollBinding(binding);

  assert.equal(refreshed, true);
  assert.equal(candidateCalls, 0);
  assert.match(editedText, /Selected edition:\n\nOnyx Storm\nRebecca Yarros/u);
  assert.match(editedText, /Status:\nChecking your library/u);
  assert.equal(
    (await bindings.lookup(binding.requestId))?.fingerprint,
    requestFingerprint(preflightRequest()),
  );
});

test("failed status edit warns safely, schedules retry, and reports zero refreshed cards", async () => {
  const senderId = "123";
  const actor = deriveActor(testConfig.actorDerivationSecret, senderId);
  const bindings = new MemoryStore<RequestBinding>();
  const initial = searchingRequest();
  const binding: RequestBinding = {
    requestId: initial.id,
    actor,
    route: { chatId: senderId },
    messageId: 42,
    fingerprint: requestFingerprint(initial),
    nextPollAt: 0,
    failureCount: 0,
    terminal: false,
    terminalNotified: false,
    createdAt: 1,
  };
  await bindings.register(binding.requestId, binding);
  const warnings: string[] = [];
  const controller = new ViktorAudiobookController(
    {
      config: {},
      logger: {
        warn(message: string) {
          warnings.push(message);
        },
        error() {},
      },
      runtime: {
        gateway: {
          async isAvailable() {
            return true;
          },
          async request() {
            throw new Error("secret response body and Telegram ids");
          },
        },
      },
    } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        return waitingRequest();
      },
      async candidates() {
        return releaseCandidates;
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings,
      callbacks: new MemoryStore<CallbackIntent>(),
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );

  const result = await controller.handleBookCommand({
    channel: "telegram",
    from: `telegram:${senderId}`,
    to: `telegram:${senderId}`,
    senderId,
    isAuthorizedSender: true,
    args: "status",
  } as PluginCommandContext);

  assert.equal(result.text, "Refreshed 0 active audiobook request cards.");
  assert.deepEqual(warnings, [
    "viktor-audiobooks: request-card refresh failed (telegram-edit-rejected)",
  ]);
  assert.equal(warnings[0]?.includes("secret"), false);
  const retried = await bindings.lookup(binding.requestId);
  assert.equal(retried?.failureCount, 1);
  assert((retried?.nextPollAt ?? 0) > Date.now());
});

test("create command keeps using the outbound Telegram send path", async () => {
  const bindings = new MemoryStore<RequestBinding>();
  const callbacks = new MemoryStore<CallbackIntent>();
  let sentPayload: Record<string, unknown> | undefined;
  const created = { ...searchingRequest(), cancel_allowed: true };
  const controller = new ViktorAudiobookController(
    {
      config: {},
      logger: { warn() {}, error() {} },
      runtime: {
        channel: {
          outbound: {
            async loadAdapter() {
              return {
                async sendPayload(payload: Record<string, unknown>) {
                  sentPayload = payload;
                  return { messageId: "51" };
                },
              };
            },
          },
        },
      },
    } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async create() {
        return created;
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings,
      callbacks,
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );

  const result = await controller.handleBookCommand({
    channel: "telegram",
    from: "telegram:123",
    to: "telegram:123",
    senderId: "123",
    isAuthorizedSender: true,
    args: "Onyx Storm by Rebecca Yarros",
  } as PluginCommandContext);

  assert.equal(result.suppressReply, true);
  assert.equal(sentPayload?.to, "123");
  assert.match(String(sentPayload?.text), /Status: Searching/u);
  const payload = sentPayload?.payload as {
    channelData: { telegram: { buttons: Array<Array<{ callback_data: string }>> } };
  };
  assert.match(payload.channelData.telegram.buttons[0]?.[0]?.callback_data ?? "", /^vab:/u);
  assert.equal((await bindings.lookup(created.id))?.messageId, 51);
  for (const callback of callbacks.values.values()) assert.equal(callback.messageId, 51);
});

test("callback refresh keeps using the Telegram context edit path", async () => {
  const senderId = "123";
  const actor = deriveActor(testConfig.actorDerivationSecret, senderId);
  const request = waitingRequest();
  const callbacks = new MemoryStore<CallbackIntent>();
  await callbacks.register("callback-token", {
    token: "callback-token",
    actor,
    requestId: request.id,
    action: "select_release",
    candidateId: 17,
    route: { chatId: senderId },
    messageId: 52,
    requestFingerprint: requestFingerprint(request),
    idempotencyKey: "callback-idempotency",
    createdAt: 1,
  });
  let edited: { text: string; buttons?: Array<Array<{ callback_data: string }>> } | undefined;
  const controller = new ViktorAudiobookController(
    { logger: { warn() {}, error() {} } } as unknown as OpenClawPluginApi,
    testConfig,
    {
      async status() {
        return request;
      },
      async control() {
        return request;
      },
      async candidates() {
        return releaseCandidates;
      },
    } as unknown as ApplicationApi,
    {
      creates: new MemoryStore<CreateIntent>(),
      bindings: new MemoryStore<RequestBinding>(),
      callbacks,
      leases: new MemoryStore<{ owner: string; createdAt: number }>(),
    },
  );

  await controller.handleCallback({
    senderId,
    accountId: "default",
    isGroup: false,
    auth: { isAuthorizedSender: true },
    callback: { payload: "callback-token", messageId: 52, chatId: senderId },
    respond: {
      async reply() {
        throw new Error("must not reply");
      },
      async editMessage(params) {
        edited = params;
      },
    },
  });

  assert.match(edited?.text ?? "", /Status: Waiting for input/u);
  assert((edited?.buttons?.length ?? 0) > 0);
  assert.match(edited?.buttons?.[0]?.[0]?.callback_data ?? "", /^vab:/u);
});
