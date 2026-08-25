import { resolveAccessGroupAllowFromState } from "openclaw/plugin-sdk/access-groups";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export const VIKTOR_MEDIA_ACCESS_GROUP = "viktor-media-users";
export const VIKTOR_MEDIA_DENIED_RESPONSE =
  "Media requests are not available for this Telegram account.";

export type ViktorMediaAuthorization =
  | { allowed: true; telegramId: string; source: "canonical" | "media-user" }
  | {
      allowed: false;
      reason: "invalid-sender" | "not-telegram" | "not-private-dm" | "not-authorized";
    };

function numericTelegramId(value: string | undefined): string | null {
  if (!value) return null;
  return /^(?:telegram:)?([1-9][0-9]*)$/u.exec(value)?.[1] ?? null;
}

export async function authorizeViktorMediaTelegramSender(params: {
  cfg?: OpenClawConfig;
  channel: string;
  accountId?: string;
  senderId?: string;
  chatId?: string;
  isGroup: boolean;
  canonicalAuthorized: boolean;
}): Promise<ViktorMediaAuthorization> {
  if (params.channel !== "telegram") return { allowed: false, reason: "not-telegram" };
  const senderId = numericTelegramId(params.senderId);
  const chatId = numericTelegramId(params.chatId);
  if (!senderId || !chatId) return { allowed: false, reason: "invalid-sender" };
  if (params.isGroup || senderId !== chatId) {
    return { allowed: false, reason: "not-private-dm" };
  }
  if (params.canonicalAuthorized) {
    return { allowed: true, telegramId: senderId, source: "canonical" };
  }

  const state = await resolveAccessGroupAllowFromState({
    accessGroups: params.cfg?.accessGroups,
    allowFrom: [`accessGroup:${VIKTOR_MEDIA_ACCESS_GROUP}`],
    channel: "telegram",
    accountId: params.accountId ?? "default",
    senderId,
    // Media authorization deliberately accepts numeric Telegram identities only.
    isSenderAllowed: (candidate, entries) =>
      entries.some((entry) => numericTelegramId(entry) === candidate),
  });
  return state.hasMatch
    ? { allowed: true, telegramId: senderId, source: "media-user" }
    : { allowed: false, reason: "not-authorized" };
}
