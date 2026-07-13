import { handleTelegramMediaCommand, hasPendingTelegramMediaClarification } from './telegram-media-handler.mjs';
import {
  buildTelegramMediaHelpText,
  buildTelegramMediaStubText,
  parseTelegramMediaCommand
} from './telegram-media-command-registry.mjs';
import {
  createMediaInvite,
  listMediaUsers,
  parseAdminCommand,
  parseInviteRedemptionText,
  readAccessConfig,
  redeemMediaInvite,
  revokeMediaAccess
} from './telegram-media-invite.mjs';
import { getTelegramMediaAccessConfigPath } from './telegram-media-paths.mjs';

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function normalizeId(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? text : '';
}

function stubForCommand(command, registry) {
  if (command === '/mediahelp') return buildTelegramMediaHelpText(registry);
  return buildTelegramMediaStubText(registry);
}

function loadConfig() {
  const cfg = readAccessConfig();
  return {
    fullAccessUserIds: cfg.fullAccessUserIds,
    mediaRequestUserIds: cfg.mediaRequestUserIds,
    unknownUserAction: cfg.unknownUserAction
  };
}

async function handleAdminCommand({ senderId, chatId, text, botUsername, now }) {
  const parsed = parseAdminCommand(text);
  if (!parsed.command) return null;
  if (parsed.command === '/mediainvite') {
    const result = await createMediaInvite({ senderId, chatId, text, botUsername, now });
    return result.handled ? result : null;
  }
  if (parsed.command === '/mediausers') {
    const result = await listMediaUsers({ senderId, chatId, text, now });
    return result.handled ? result : null;
  }
  if (parsed.command === '/mediarevoke') {
    const result = await revokeMediaAccess({ senderId, chatId, text, now });
    return result.handled ? result : null;
  }
  return null;
}

async function handleInviteRedemption({ senderId, chatId, text, now }) {
  if (!parseInviteRedemptionText(text)) return null;
  const result = await redeemMediaInvite({ senderId, chatId, text, now });
  return result.handled ? result : null;
}

async function evaluateTelegramMediaAccess({ provider, senderId, chatId, text, mediaHandler = handleTelegramMediaCommand, botUsername = '', now = Date.now() }) {
  const cfg = loadConfig();
  const normalizedSenderId = normalizeId(senderId);
  const parsed = parseTelegramMediaCommand(text);
  const command = parsed.command;
  const registry = parsed.registry;
  const isFullAccessUser = cfg.fullAccessUserIds.includes(normalizedSenderId);
  const isMediaRequestUser = cfg.mediaRequestUserIds.includes(normalizedSenderId);
  const hasPending = hasPendingTelegramMediaClarification({ userId: normalizedSenderId, chatId, now });

  if (String(provider || '').toLowerCase() !== 'telegram') {
    return {
      decision: 'continue_normal',
      route: 'normal',
      reason: 'non_telegram_provider',
      responseText: null
    };
  }

  if (isFullAccessUser) {
    const adminResult = await handleAdminCommand({ senderId: normalizedSenderId, chatId, text, botUsername, now });
    if (adminResult) {
      return {
        decision: 'intercept_media_only',
        route: 'telegram_media_admin',
        reason: 'full_access_admin_command',
        responseText: adminResult.responseText
      };
    }
  }

  const redemptionResult = await handleInviteRedemption({ senderId: normalizedSenderId, chatId, text, now });
  if (redemptionResult) {
    return {
      decision: 'intercept_media_only',
      route: 'telegram_media_enrollment',
      reason: redemptionResult.outcome || 'invite_redemption',
      responseText: redemptionResult.responseText
    };
  }

  if (isFullAccessUser && !command && !hasPending) {
    return {
      decision: 'continue_normal',
      route: 'normal',
      reason: 'full_access_user',
      responseText: null
    };
  }

  if (isFullAccessUser || isMediaRequestUser || hasPending) {
    const mediaResult = await mediaHandler(text, { userId: normalizedSenderId, chatId, now });
    return {
      decision: 'intercept_media_only',
      route: mediaResult.kind === 'handled' ? 'telegram_media_handler' : 'telegram_media_stub',
      reason: hasPending && !command ? 'pending_clarification' : isFullAccessUser ? 'full_access_command' : 'media_request_user',
      responseText: mediaResult.responseText ?? stubForCommand(command || '', registry),
      allowedCommands: registry.commands.map((entry) => entry.command)
    };
  }

  return {
    decision: cfg.unknownUserAction === 'deny' ? 'deny' : 'ignore',
    route: 'none',
    reason: 'unknown_user',
    responseText: cfg.unknownUserAction === 'deny' ? 'Access denied.' : null
  };
}

function parseArgs(argv) {
  const out = { provider: 'telegram', senderId: '', chatId: '', text: '', botUsername: '', now: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--provider') out.provider = argv[++i] || '';
    else if (arg === '--sender-id') out.senderId = argv[++i] || '';
    else if (arg === '--chat-id') out.chatId = argv[++i] || '';
    else if (arg === '--text') out.text = argv[++i] || '';
    else if (arg === '--bot-username') out.botUsername = argv[++i] || '';
    else if (arg === '--now') out.now = argv[++i] || '';
    else die(`Unknown arg: ${arg}`, 2);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.senderId) die('Usage: node scripts/telegram-media-gate.mjs --sender-id <numeric-id> --text "<message>" [--provider telegram] [--chat-id <chat-id>] [--bot-username <bot-username>] [--now <epoch-ms>]', 2);
  const result = await evaluateTelegramMediaAccess({
    ...args,
    now: args.now ? Number(args.now) : Date.now()
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { evaluateTelegramMediaAccess, getTelegramMediaAccessConfigPath, loadConfig, stubForCommand };
