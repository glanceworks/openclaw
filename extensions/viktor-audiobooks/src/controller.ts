import { randomUUID } from "node:crypto";

import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/core";

import { ApplicationApi, ApplicationApiError } from "./api-client.js";
import { deriveActor, timingSafeActorEqual } from "./actor.js";
import {
  bindCallbackMessage,
  renderCard,
  requestFingerprint,
  requestIsTerminal,
  safeRequestStatus,
} from "./cards.js";
import type { PluginStores } from "./state.js";
import type {
  BookRequest,
  CallbackIntent,
  CandidateSet,
  CreateIntent,
  PluginConfig,
  RequestBinding,
  Route,
} from "./types.js";

type TelegramInteractiveContext = {
  senderId?: string;
  accountId: string;
  threadId?: number;
  isGroup: boolean;
  auth: { isAuthorizedSender: boolean };
  callback: {
    payload: string;
    messageId: number;
    chatId: string;
  };
  respond: {
    reply(params: { text: string }): Promise<void>;
    editMessage(params: {
      text: string;
      buttons?: Array<Array<{ text: string; callback_data: string; style?: string }>>;
    }): Promise<void>;
  };
};

type RefreshFailureClassification =
  | "telegram-edit-unavailable"
  | "telegram-edit-rejected"
  | "candidate-fetch-failed"
  | "status-fetch-failed"
  | "unknown-refresh-failure";

class RefreshFailure extends Error {
  constructor(
    readonly classification: RefreshFailureClassification,
    readonly originalError?: unknown,
  ) {
    super(classification);
    this.name = "RefreshFailure";
  }
}

function refreshFailureClassification(error: unknown): RefreshFailureClassification {
  return error instanceof RefreshFailure ? error.classification : "unknown-refresh-failure";
}

function refreshOriginalError(error: unknown): unknown {
  return error instanceof RefreshFailure ? error.originalError : error;
}

export type ParsedBookCommand =
  | { kind: "create"; title: string; author: string }
  | { kind: "status" }
  | { kind: "cancel" }
  | { kind: "help" }
  | { kind: "invalid" };

export function parseBookCommand(rawArgs: string): ParsedBookCommand {
  const args = rawArgs.trim().replace(/\s+/gu, " ");
  if (!args || args.toLowerCase() === "help") return { kind: "help" };
  if (args.toLowerCase() === "status") return { kind: "status" };
  if (args.toLowerCase() === "cancel") return { kind: "cancel" };
  if (args.length > 804) return { kind: "invalid" };
  const separator = args.toLowerCase().lastIndexOf(" by ");
  if (separator <= 0) return { kind: "create", title: args.slice(0, 500), author: "" };
  const title = args.slice(0, separator).trim();
  const author = args.slice(separator + 4).trim();
  if (!title || !author || title.length > 500 || author.length > 300) return { kind: "invalid" };
  return { kind: "create", title, author };
}

export function directTelegramRoute(ctx: PluginCommandContext): Route | null {
  if (
    ctx.channel !== "telegram" ||
    !ctx.from ||
    !ctx.to ||
    !ctx.senderId ||
    ctx.from !== ctx.to
  ) return null;
  const chatMatch = /^telegram:([1-9][0-9]*)$/u.exec(ctx.to);
  const senderMatch = /^(?:telegram:)?([1-9][0-9]*)$/u.exec(ctx.senderId);
  if (!chatMatch?.[1] || chatMatch[1] !== senderMatch?.[1]) return null;
  return {
    chatId: chatMatch[1],
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    ...(typeof ctx.messageThreadId === "number" ? { threadId: ctx.messageThreadId } : {}),
  };
}

export function callbackMatchesIntent(params: {
  intent: CallbackIntent;
  actor: string;
  chatId: string;
  messageId: number;
  threadId?: number;
}): boolean {
  const { intent, actor, chatId, messageId, threadId } = params;
  return Boolean(
    timingSafeActorEqual(intent.actor, actor) &&
      intent.route.chatId === chatId &&
      intent.messageId === messageId &&
      intent.route.threadId === threadId,
  );
}

function candidatesNeeded(request: BookRequest): boolean {
  return request.job?.stage === "select_release" || request.job?.stage === "select_nzb";
}

function pollDelay(request: BookRequest): number {
  if (requestIsTerminal(request)) return Number.POSITIVE_INFINITY;
  if (request.job?.stage === "monitor_sab") return 60_000;
  if (
    request.job?.status === "waiting_user" ||
    request.job?.status === "needs_attention" ||
    request.job?.status === "needs_login"
  ) {
    return 5 * 60_000;
  }
  return 10_000;
}

function safeFailureText(error: unknown): string {
  if (error instanceof ApplicationApiError) {
    if (error.status === 429) return "Audiobook Automation is busy. I’ll retry shortly.";
    if (error.status === 401 || error.status === 403) {
      return "The audiobook integration needs owner attention.";
    }
    if (error.code === "request_not_found") return "That audiobook request is no longer available.";
  }
  return "I couldn’t refresh that audiobook request safely. Please try again later.";
}

export class ViktorAudiobookController {
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private authAlertSent = false;
  private readonly instanceId = randomUUID();

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly config: PluginConfig,
    private readonly application: ApplicationApi,
    private readonly stores: PluginStores,
  ) {}

  async handleBookCommand(ctx: PluginCommandContext): Promise<PluginCommandResult> {
    if (!ctx.isAuthorizedSender || !ctx.senderId) {
      return { text: "This command is not available.", isError: true };
    }
    const route = directTelegramRoute(ctx);
    if (!route) return { text: "Use /book in a direct Telegram chat with Viktor." };
    const actor = deriveActor(this.config.actorDerivationSecret, ctx.senderId);
    const parsed = parseBookCommand(ctx.args ?? "");
    if (parsed.kind === "help" || parsed.kind === "invalid") {
      return {
        text: "Use /book <title> [by <author>], /book status, or /book cancel.",
      };
    }
    if (parsed.kind === "status" || parsed.kind === "cancel") {
      const refreshed = await this.refreshActorBindings(actor, true);
      const suffix = parsed.kind === "cancel"
        ? " Use a request-specific Cancel button when it is available."
        : "";
      return { text: `Refreshed ${refreshed} active audiobook request card${refreshed === 1 ? "" : "s"}.${suffix}` };
    }

    try {
      await this.createAndPost(actor, parsed.title, parsed.author, route);
      return { suppressReply: true };
    } catch (error) {
      this.api.logger.warn(`viktor-audiobooks: create/card delivery failed (${safeFailureText(error)})`);
      return { text: safeFailureText(error), isError: true };
    }
  }

  async createFromOwnerTool(params: {
    title: string;
    author?: string;
    trustedSenderId: string;
    route: Route;
  }): Promise<string> {
    const actor = deriveActor(this.config.actorDerivationSecret, params.trustedSenderId);
    await this.createAndPost(actor, params.title, params.author ?? "", params.route);
    return "The audiobook request was created and its Telegram card was posted.";
  }

  async handleCallback(ctx: TelegramInteractiveContext): Promise<{ handled: true }> {
    if (ctx.isGroup || !ctx.auth.isAuthorizedSender || !ctx.senderId) {
      await ctx.respond.reply({ text: "This action is not authorized." });
      return { handled: true };
    }
    const actor = deriveActor(this.config.actorDerivationSecret, ctx.senderId);
    const intent = await this.stores.callbacks.lookup(ctx.callback.payload);
    if (
      !intent ||
      !callbackMatchesIntent({
        intent,
        actor,
        chatId: ctx.callback.chatId,
        messageId: ctx.callback.messageId,
        ...(ctx.threadId === undefined ? {} : { threadId: ctx.threadId }),
      })
    ) {
      await ctx.respond.reply({ text: "That button is expired or belongs to another request." });
      return { handled: true };
    }

    try {
      const current = await this.application.status(actor, intent.requestId);
      if (requestFingerprint(current) !== intent.requestFingerprint) {
        await this.editFromCallback(ctx, actor, current);
        return { handled: true };
      }
      if (intent.action === "cancel" && !current.cancel_allowed) {
        await this.editFromCallback(ctx, actor, current);
        return { handled: true };
      }
      let updated: BookRequest;
      if (intent.action === "acquire_release") {
        if (intent.candidateId === undefined) {
          await this.editFromCallback(ctx, actor, current);
          return { handled: true };
        }
        updated = await this.application.releaseAcquisition(
          actor,
          intent.requestId,
          intent.candidateId,
          intent.idempotencyKey,
        );
      } else {
        updated = await this.application.control(
          actor,
          intent.requestId,
          {
            select_release: "release-selection",
            authorize: "reveal-authorization",
            select_nzb: "nzb-selection",
            cancel: "cancel",
          }[intent.action],
          intent.idempotencyKey,
          intent.candidateId,
        );
      }
      await this.stores.callbacks.consume(intent.token);
      await this.editFromCallback(ctx, actor, updated);
      return { handled: true };
    } catch (error) {
      await ctx.respond.reply({ text: safeFailureText(error) });
      return { handled: true };
    }
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(5_000));
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const claimed = await this.stores.leases.registerIfAbsent(
      "poller",
      { owner: this.instanceId, createdAt: Date.now() },
      { ttlMs: 30_000 },
    );
    if (!claimed) return;
    try {
      await this.recoverCreateIntents();
      for (const entry of await this.stores.bindings.entries()) {
        if (!entry.value.terminal && entry.value.nextPollAt <= Date.now()) {
          await this.pollBinding(entry.value);
        }
      }
    } finally {
      await this.stores.leases.consume("poller");
    }
  }

  private async createAndPost(actor: string, title: string, author: string, route: Route): Promise<void> {
    const idempotencyKey = `tg-create-${randomUUID()}`;
    const intent: CreateIntent = {
      idempotencyKey,
      actor,
      title,
      author,
      route,
      createdAt: Date.now(),
    };
    if (!(await this.stores.creates.registerIfAbsent(idempotencyKey, intent))) {
      throw new Error("Duplicate local create intent.");
    }
    const request = await this.application.create(actor, title, author, idempotencyKey);
    await this.stores.creates.register(idempotencyKey, { ...intent, requestId: request.id });
    await this.postNewCard(request, actor, route, idempotencyKey);
    await this.stores.creates.delete(idempotencyKey);
  }

  private async postNewCard(
    request: BookRequest,
    actor: string,
    route: Route,
    createIntentKey: string,
  ): Promise<void> {
    const candidates = await this.loadCandidatesIfNeeded(actor, request);
    const card = await renderCard({
      request,
      ...(candidates ? { candidates } : {}),
      actor,
      route,
      callbacks: this.stores.callbacks,
    });
    const createIntent = await this.stores.creates.lookup(createIntentKey);
    if (!createIntent) throw new Error("The durable create intent is unavailable.");
    await this.stores.creates.register(createIntentKey, {
      ...createIntent,
      requestId: request.id,
      cardDeliveryStartedAt: Date.now(),
    });
    const adapter = await this.api.runtime.channel.outbound.loadAdapter("telegram");
    if (!adapter?.sendPayload) throw new Error("Telegram payload delivery is unavailable.");
    const result = await adapter.sendPayload({
      cfg: this.api.config,
      to: route.chatId,
      text: card.text,
      payload: { text: card.text, channelData: { telegram: { buttons: card.buttons } } },
      ...(route.accountId ? { accountId: route.accountId } : {}),
      ...(route.threadId === undefined ? {} : { threadId: route.threadId }),
    });
    const messageId = Number.parseInt(result.messageId, 10);
    if (!Number.isSafeInteger(messageId) || messageId < 1) {
      throw new Error("Telegram did not return a usable message id.");
    }
    await bindCallbackMessage(this.stores.callbacks, card.callbackTokens, messageId);
    const binding: RequestBinding = {
      requestId: request.id,
      actor,
      route,
      messageId,
      fingerprint: requestFingerprint(request),
      nextPollAt: Date.now() + pollDelay(request),
      failureCount: 0,
      terminal: requestIsTerminal(request),
      terminalNotified: false,
      createdAt: Date.now(),
    };
    await this.stores.bindings.register(request.id, binding);
  }

  private async recoverCreateIntents(): Promise<void> {
    for (const entry of await this.stores.creates.entries()) {
      const intent = entry.value;
      try {
        const binding = intent.requestId
          ? await this.stores.bindings.lookup(intent.requestId)
          : undefined;
        if (binding) {
          await this.stores.creates.delete(entry.key);
          continue;
        }
        if (intent.cardDeliveryStartedAt) {
          if (!intent.cardDeliveryUncertainAt) {
            await this.stores.creates.register(entry.key, {
              ...intent,
              cardDeliveryUncertainAt: Date.now(),
            });
            this.api.logger.error(
              "viktor-audiobooks: card delivery is ambiguous; automatic resend suppressed",
            );
          }
          continue;
        }
        const request = intent.requestId
          ? await this.application.status(intent.actor, intent.requestId)
          : await this.application.create(
              intent.actor,
              intent.title,
              intent.author,
              intent.idempotencyKey,
            );
        if (!intent.requestId) {
          await this.stores.creates.register(entry.key, { ...intent, requestId: request.id });
        }
        await this.postNewCard(request, intent.actor, intent.route, entry.key);
        await this.stores.creates.delete(entry.key);
      } catch (error) {
        await this.handleBackgroundFailure(error);
      }
    }
  }

  private async refreshActorBindings(actor: string, forceEdit: boolean): Promise<number> {
    let count = 0;
    for (const entry of await this.stores.bindings.entries()) {
      if (!timingSafeActorEqual(entry.value.actor, actor) || entry.value.terminal) continue;
      if (await this.pollBinding(entry.value, forceEdit)) count += 1;
    }
    return count;
  }

  private async pollBinding(binding: RequestBinding, forceEdit = false): Promise<boolean> {
    try {
      let request: BookRequest;
      try {
        request = await this.application.status(binding.actor, binding.requestId);
      } catch (error) {
        throw new RefreshFailure("status-fetch-failed", error);
      }
      const fingerprint = requestFingerprint(request);
      if (forceEdit || fingerprint !== binding.fingerprint) {
        await this.editBoundCard(binding, request);
      }
      const terminal = requestIsTerminal(request);
      if (terminal) {
        const terminalBinding: RequestBinding = {
          ...binding,
          fingerprint,
          nextPollAt: Number.MAX_SAFE_INTEGER,
          failureCount: 0,
          terminal: true,
          terminalNotified: binding.terminalNotified,
          ...(binding.terminalNotificationStartedAt
            ? { terminalNotificationStartedAt: binding.terminalNotificationStartedAt }
            : { terminalNotificationStartedAt: Date.now() }),
        };
        await this.stores.bindings.register(binding.requestId, terminalBinding);
        if (!terminalBinding.terminalNotified && !binding.terminalNotificationStartedAt) {
          try {
            await this.sendTerminalNotification(binding, request);
            await this.stores.bindings.register(binding.requestId, {
              ...terminalBinding,
              terminalNotified: true,
            });
          } catch (error) {
            await this.handleBackgroundFailure(error);
            this.api.logger.error(
              "viktor-audiobooks: terminal notification delivery is ambiguous; automatic resend suppressed",
            );
          }
        }
        return true;
      }
      await this.stores.bindings.register(binding.requestId, {
        ...binding,
        fingerprint,
        nextPollAt: Date.now() + pollDelay(request),
        failureCount: 0,
        terminal: false,
      });
      return true;
    } catch (error) {
      const originalError = refreshOriginalError(error);
      await this.handleBackgroundFailure(originalError);
      if (
        !(originalError instanceof ApplicationApiError) ||
        (originalError.status !== 401 && originalError.status !== 403)
      ) {
        this.api.logger.warn(
          `viktor-audiobooks: request-card refresh failed (${refreshFailureClassification(error)})`,
        );
      }
      const retryAfter =
        originalError instanceof ApplicationApiError ? originalError.retryAfterMs : undefined;
      const failureCount = binding.failureCount + 1;
      await this.stores.bindings.register(binding.requestId, {
        ...binding,
        failureCount,
        nextPollAt:
          Date.now() +
          (retryAfter ?? Math.min(5 * 60_000, 5_000 * 2 ** Math.min(failureCount, 6))) +
          Math.floor(Math.random() * 1_000),
      });
      return false;
    }
  }

  private async handleBackgroundFailure(error: unknown): Promise<void> {
    if (!(error instanceof ApplicationApiError) || (error.status !== 401 && error.status !== 403)) {
      return;
    }
    this.stopped = true;
    this.api.logger.error("viktor-audiobooks: API authentication failed; polling stopped");
    if (!this.authAlertSent && this.config.ownerNotificationTarget) {
      this.authAlertSent = true;
      const send = (await this.api.runtime.channel.outbound.loadAdapter("telegram"))?.sendText;
      if (send) {
        await send({
          cfg: this.api.config,
          to: this.config.ownerNotificationTarget,
          text: "The audiobook integration needs owner attention; background polling stopped.",
        });
      }
    }
  }

  private async loadCandidatesIfNeeded(
    actor: string,
    request: BookRequest,
  ): Promise<CandidateSet | undefined> {
    return candidatesNeeded(request)
      ? await this.application.candidates(actor, request.id)
      : undefined;
  }

  private async editFromCallback(
    ctx: TelegramInteractiveContext,
    actor: string,
    request: BookRequest,
  ): Promise<void> {
    const candidates = await this.loadCandidatesIfNeeded(actor, request);
    const route: Route = {
      chatId: ctx.callback.chatId,
      accountId: ctx.accountId,
      ...(ctx.threadId === undefined ? {} : { threadId: ctx.threadId }),
    };
    const card = await renderCard({
      request,
      ...(candidates ? { candidates } : {}),
      actor,
      route,
      messageId: ctx.callback.messageId,
      callbacks: this.stores.callbacks,
    });
    await ctx.respond.editMessage({ text: card.text, buttons: card.buttons });
    const existing = await this.stores.bindings.lookup(request.id);
    if (existing) {
      await this.stores.bindings.register(request.id, {
        ...existing,
        fingerprint: requestFingerprint(request),
        nextPollAt: Date.now() + pollDelay(request),
        failureCount: 0,
        terminal: requestIsTerminal(request),
      });
    }
  }

  private async editBoundCard(binding: RequestBinding, request: BookRequest): Promise<void> {
    let candidates: CandidateSet | undefined;
    try {
      candidates = await this.loadCandidatesIfNeeded(binding.actor, request);
    } catch (error) {
      throw new RefreshFailure("candidate-fetch-failed", error);
    }
    const card = await renderCard({
      request,
      ...(candidates ? { candidates } : {}),
      actor: binding.actor,
      route: binding.route,
      messageId: binding.messageId,
      callbacks: this.stores.callbacks,
    });
    let gatewayAvailable = false;
    try {
      gatewayAvailable = await this.api.runtime.gateway.isAvailable();
    } catch {
      throw new RefreshFailure("telegram-edit-unavailable");
    }
    if (!gatewayAvailable) throw new RefreshFailure("telegram-edit-unavailable");
    try {
      await this.api.runtime.gateway.request("message.action", {
        channel: "telegram",
        action: "edit",
        idempotencyKey: "viktor-audiobooks:request-card-edit:" + randomUUID(),
        params: {
          chatId: binding.route.chatId,
          messageId: binding.messageId,
          content: card.text,
          interactive: card.buttons.length
            ? {
                blocks: [{ type: "buttons", buttons: card.buttons.flat() }],
              }
            : undefined,
        },
        ...(binding.route.accountId ? { accountId: binding.route.accountId } : {}),
      });
    } catch (error) {
      throw new RefreshFailure("telegram-edit-rejected", error);
    }
  }

  private async sendTerminalNotification(
    binding: RequestBinding,
    request: BookRequest,
  ): Promise<void> {
    const send = (await this.api.runtime.channel.outbound.loadAdapter("telegram"))?.sendText;
    if (!send) throw new Error("Telegram notification delivery is unavailable.");
    await send({
      cfg: this.api.config,
      to: binding.route.chatId,
      text: `${request.title}: ${safeRequestStatus(request.status)}.`,
      ...(binding.route.accountId ? { accountId: binding.route.accountId } : {}),
      ...(binding.route.threadId === undefined ? {} : { threadId: binding.route.threadId }),
    });
  }
}
