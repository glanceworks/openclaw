import type {
  OpenClawConfig,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/core";
import { authorizeViktorMediaTelegramSender, VIKTOR_MEDIA_DENIED_RESPONSE } from "../api.js";
import { ArrApiError, type ArrClient, type MediaKind, type RequestResult } from "./arr-client.js";

function directTelegramDm(ctx: PluginCommandContext): boolean {
  if (ctx.channel !== "telegram" || !ctx.from || !ctx.to || !ctx.senderId || ctx.from !== ctx.to) {
    return false;
  }
  const chat = /^telegram:([1-9][0-9]*)$/u.exec(ctx.to)?.[1];
  const sender = /^(?:telegram:)?([1-9][0-9]*)$/u.exec(ctx.senderId)?.[1];
  return Boolean(chat && chat === sender);
}

function usage(kind: MediaKind): string {
  return kind === "movie" ? "Usage: /movie <title>" : "Usage: /show <title>";
}

function serviceName(kind: MediaKind): "Radarr" | "Sonarr" {
  return kind === "movie" ? "Radarr" : "Sonarr";
}

function commandName(kind: MediaKind): "/movie" | "/show" {
  return kind === "movie" ? "/movie" : "/show";
}

function renderResult(kind: MediaKind, result: RequestResult): string {
  const service = serviceName(kind);
  if (result.status === "added") {
    return result.searchAccepted
      ? `${result.title} added to ${service}; search accepted.`
      : `${result.title} added to ${service}, but search could not be started.`;
  }
  if (result.status === "already-managed") {
    return result.unmonitored
      ? `${result.title} is already in ${service}, but it is not monitored.`
      : `${result.title} is already in ${service}.`;
  }
  if (result.status === "no-result") {
    return `${service} could not find that title.`;
  }
  const choices = result.choices
    .map(
      (choice, index) => `${index + 1}. ${choice.title}${choice.year ? ` (${choice.year})` : ""}`,
    )
    .join("; ");
  return `I could not identify one confident match. ${choices}. Rerun ${commandName(kind)} <exact title> <year>.`;
}

function renderFailure(error: unknown, kind: MediaKind): string {
  const service = serviceName(kind);
  if (!(error instanceof ArrApiError)) {
    return `${service} could not process that request right now.`;
  }
  if (error.kind === "authentication") {
    return `${service} authentication needs owner attention.`;
  }
  if (error.kind === "backend-unavailable") {
    return `${service} is unavailable right now. Try again later.`;
  }
  return `${service} rejected that request.`;
}

export class ViktorMediaController {
  constructor(
    private readonly client: ArrClient,
    private readonly config: OpenClawConfig,
  ) {}

  async handle(kind: MediaKind, ctx: PluginCommandContext): Promise<PluginCommandResult> {
    const routeIsDirect = directTelegramDm(ctx);
    const authorization = await authorizeViktorMediaTelegramSender({
      cfg: this.config,
      channel: ctx.channel,
      accountId: ctx.accountId,
      senderId: ctx.senderId,
      chatId: routeIsDirect ? ctx.to : undefined,
      isGroup: !routeIsDirect,
      canonicalAuthorized: ctx.isAuthorizedSender === true,
    });
    if (!authorization.allowed && authorization.reason === "not-authorized") {
      return { text: VIKTOR_MEDIA_DENIED_RESPONSE, isError: true };
    }
    if (!authorization.allowed) {
      return { text: `Use ${commandName(kind)} in a direct Telegram chat with Viktor.` };
    }
    const title = (ctx.args ?? "").trim().replace(/\s+/gu, " ");
    if (!title || title.length > 500) {
      return { text: usage(kind) };
    }
    try {
      return { text: renderResult(kind, await this.client.request(kind, title)) };
    } catch (error) {
      return { text: renderFailure(error, kind), isError: true };
    }
  }
}

export { directTelegramDm, renderFailure, renderResult };
