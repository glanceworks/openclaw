import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  getTelegramMediaAccessConfigPath,
  getTelegramMediaEnrollmentAuditLogPath,
  getTelegramMediaEnrollmentStatePath
} from './telegram-media-paths.mjs';

const INVITE_TTL_MS = 15 * 60 * 1000;
const TOKEN_PREFIX = 'media-';
const TOKEN_BYTES = 24;

let mutationChain = Promise.resolve();

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function getStatePath() {
  return getTelegramMediaEnrollmentStatePath();
}

function getLogPath() {
  return getTelegramMediaEnrollmentAuditLogPath();
}

function normalizeId(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? text : '';
}

function normalizeChatId(value) {
  return String(value ?? '').trim();
}

function isDirectMessage({ senderId, chatId }) {
  const sender = normalizeId(senderId);
  const chat = normalizeChatId(chatId);
  if (!chat) return true;
  return Boolean(sender) && chat === sender;
}

function normalizeLabel(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function labelKey(value) {
  return normalizeLabel(value).toLowerCase();
}

function maskId(value) {
  const id = normalizeId(value);
  if (!id) return 'unknown';
  return `...${id.slice(-4)}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function tokenPreview(token) {
  const raw = String(token || '');
  return raw ? `${raw.slice(0, 6)}…` : '';
}

function writeJsonAtomic(filePath, data) {
  ensureParent(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmpPath, filePath);
}

function appendAudit(entry) {
  const logPath = getLogPath();
  ensureParent(logPath);
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readAccessConfig() {
  const cfg = readJson(getTelegramMediaAccessConfigPath());
  const telegram = cfg.telegram || {};
  const fullAccessUserIds = Array.isArray(telegram.fullAccessUserIds) ? telegram.fullAccessUserIds.map(normalizeId).filter(Boolean) : [];
  const mediaRequestUserIds = Array.isArray(telegram.mediaRequestUserIds) ? telegram.mediaRequestUserIds.map(normalizeId).filter(Boolean) : [];
  const unknownUserAction = telegram.unknownUserAction === 'deny' ? 'deny' : 'ignore';
  return { cfg, telegram, fullAccessUserIds, mediaRequestUserIds, unknownUserAction };
}

function writeAccessConfig(cfg) {
  writeJsonAtomic(getTelegramMediaAccessConfigPath(), cfg);
}

function emptyState() {
  return { version: 1, pendingInvites: [], activeUsers: [] };
}

function pruneState(state, now) {
  const activeConfigIds = new Set(readAccessConfig().mediaRequestUserIds);
  return {
    version: 1,
    pendingInvites: (Array.isArray(state.pendingInvites) ? state.pendingInvites : []).filter((invite) => Number(invite.expiresAt || 0) > now && !invite.cancelledAt && !invite.redeemedAt),
    activeUsers: (Array.isArray(state.activeUsers) ? state.activeUsers : [])
      .filter((entry) => activeConfigIds.has(normalizeId(entry.userId)))
      .map((entry) => ({
        label: normalizeLabel(entry.label),
        labelKey: labelKey(entry.labelKey || entry.label),
        userId: normalizeId(entry.userId),
        addedAt: entry.addedAt || null,
        createdBy: normalizeId(entry.createdBy),
        createdByMasked: entry.createdByMasked || maskId(entry.createdBy),
        inviteCreatedAt: entry.inviteCreatedAt || null
      }))
      .filter((entry) => entry.label && entry.labelKey && entry.userId)
  };
}

function readState(now = Date.now()) {
  try {
    return pruneState(readJson(getStatePath()), now);
  } catch {
    return emptyState();
  }
}

function writeState(state) {
  writeJsonAtomic(getStatePath(), state);
}

function withMutationLock(fn) {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.catch(() => {});
  return run;
}

function parseAdminCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return { command: '', arg: '' };
  const first = raw.split(/\s+/, 1)[0].toLowerCase().replace(/@\S+$/, '');
  const arg = raw.slice(raw.split(/\s+/, 1)[0].length).trim();
  if (first === '/mediainvite' || first === '/mediausers' || first === '/mediarevoke') {
    return { command: first, arg };
  }
  return { command: '', arg: '' };
}

function parseInviteRedemptionText(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/start')) return null;
  const first = raw.split(/\s+/, 1)[0].toLowerCase().replace(/@\S+$/, '');
  if (first !== '/start') return null;
  const arg = raw.slice(raw.split(/\s+/, 1)[0].length).trim();
  if (!arg.startsWith(TOKEN_PREFIX)) return null;
  return {
    command: '/start',
    rawTokenArg: arg,
    token: arg.slice(TOKEN_PREFIX.length)
  };
}

function buildInviteDeepLink(botUsername, token) {
  const normalized = String(botUsername || '').trim().replace(/^@+/, '');
  if (!normalized) return '';
  return `https://t.me/${normalized}?start=${TOKEN_PREFIX}${encodeURIComponent(token)}`;
}

function summarizePendingInvite(invite, now) {
  const remainingMs = Math.max(0, Number(invite.expiresAt || 0) - now);
  const remainingMin = Math.max(1, Math.ceil(remainingMs / 60000));
  return `- ${invite.label} (pending, expires in ${remainingMin}m)`;
}

function summarizeActiveUser(user) {
  return `- ${user.label} (${maskId(user.userId)})`;
}

async function createMediaInvite({ senderId, text, botUsername, now = Date.now() }) {
  return withMutationLock(async () => {
    const { command, arg } = parseAdminCommand(text);
    if (command !== '/mediainvite') return { handled: false, responseText: null };
    const label = normalizeLabel(arg);
    if (!label) {
      return { handled: true, responseText: 'Usage: /mediainvite <label>' };
    }
    const normalizedBotUsername = String(botUsername || '').trim().replace(/^@+/, '');
    if (!normalizedBotUsername) {
      return { handled: true, responseText: 'Bot username is unavailable right now, so I cannot build a Telegram invite link yet.' };
    }

    const state = readState(now);
    const key = labelKey(label);
    if (state.pendingInvites.some((invite) => invite.labelKey === key)) {
      return { handled: true, responseText: `An active invite for ${label} already exists. Use /mediausers to review it or /mediarevoke ${label} to cancel it.` };
    }
    if (state.activeUsers.some((entry) => entry.labelKey === key)) {
      return { handled: true, responseText: `${label} already has media-only access. Use /mediausers to review or /mediarevoke ${label} to remove it.` };
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const invite = {
      label,
      labelKey: key,
      tokenHash: hashToken(token),
      tokenPreview: tokenPreview(token),
      createdAt: new Date(now).toISOString(),
      createdBy: normalizeId(senderId),
      createdByMasked: maskId(senderId),
      expiresAt: now + INVITE_TTL_MS
    };
    state.pendingInvites.push(invite);
    writeState(state);
    appendAudit({
      ts: new Date(now).toISOString(),
      action: 'invite_created',
      label,
      createdBy: maskId(senderId),
      tokenPreview: invite.tokenPreview
    });

    const deepLink = buildInviteDeepLink(normalizedBotUsername, token);
    return {
      handled: true,
      responseText: `Invite for ${label}: ${deepLink}\nValid for 15 minutes. Single use. Share it privately.`
    };
  });
}

async function listMediaUsers({ now = Date.now(), text }) {
  const { command } = parseAdminCommand(text);
  if (command !== '/mediausers') return { handled: false, responseText: null };

  const state = readState(now);
  const { mediaRequestUserIds } = readAccessConfig();
  const known = new Map(state.activeUsers.map((entry) => [entry.userId, entry]));
  const activeLines = mediaRequestUserIds.map((userId) => {
    const entry = known.get(userId);
    return entry ? summarizeActiveUser(entry) : `- (unlabeled) (${maskId(userId)})`;
  });
  const pendingLines = state.pendingInvites.length > 0
    ? state.pendingInvites.map((invite) => summarizePendingInvite(invite, now))
    : ['- none'];

  return {
    handled: true,
    responseText: [
      'Media-only users:',
      ...(activeLines.length > 0 ? activeLines : ['- none']),
      'Pending invites:',
      ...pendingLines
    ].join('\n')
  };
}

async function revokeMediaAccess({ senderId, text, now = Date.now() }) {
  return withMutationLock(async () => {
    const { command, arg } = parseAdminCommand(text);
    if (command !== '/mediarevoke') return { handled: false, responseText: null };
    const label = normalizeLabel(arg);
    if (!label) {
      return { handled: true, responseText: 'Usage: /mediarevoke <label>' };
    }

    const state = readState(now);
    const key = labelKey(label);
    const pendingBefore = state.pendingInvites.length;
    const pendingRemoved = state.pendingInvites.filter((invite) => invite.labelKey === key);
    state.pendingInvites = state.pendingInvites.filter((invite) => invite.labelKey !== key);

    const activeMatches = state.activeUsers.filter((entry) => entry.labelKey === key);
    const activeIds = new Set(activeMatches.map((entry) => entry.userId));
    state.activeUsers = state.activeUsers.filter((entry) => entry.labelKey !== key);

    if (pendingBefore === state.pendingInvites.length && activeIds.size === 0) {
      writeState(state);
      return { handled: true, responseText: `No pending invite or active media user found for ${label}.` };
    }

    if (activeIds.size > 0) {
      const { cfg, telegram, mediaRequestUserIds } = readAccessConfig();
      const nextIds = mediaRequestUserIds.filter((userId) => !activeIds.has(userId));
      cfg.telegram = {
        ...telegram,
        mediaRequestUserIds: nextIds
      };
      writeAccessConfig(cfg);
    }

    writeState(state);
    appendAudit({
      ts: new Date(now).toISOString(),
      action: 'invite_revoked',
      label,
      revokedBy: maskId(senderId),
      removedUsers: Array.from(activeIds).map(maskId),
      cancelledInvites: pendingRemoved.length
    });

    const parts = [];
    if (pendingRemoved.length > 0) parts.push(`cancelled ${pendingRemoved.length} pending invite${pendingRemoved.length === 1 ? '' : 's'}`);
    if (activeIds.size > 0) parts.push(`removed media-only access for ${Array.from(activeIds).map(maskId).join(', ')}`);
    return {
      handled: true,
      responseText: `${label}: ${parts.join(' and ')}.`
    };
  });
}

async function redeemMediaInvite({ senderId, chatId, text, now = Date.now() }) {
  return withMutationLock(async () => {
    const parsed = parseInviteRedemptionText(text);
    if (!parsed) return { handled: false, responseText: null, outcome: 'not_redemption' };
    if (!isDirectMessage({ senderId, chatId })) {
      return {
        handled: true,
        responseText: 'Media enrollment links only work in a private DM with this bot.',
        outcome: 'group_rejected'
      };
    }
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(parsed.token)) {
      return {
        handled: true,
        responseText: 'This media invite link is invalid or expired.',
        outcome: 'malformed'
      };
    }

    const state = readState(now);
    const invite = state.pendingInvites.find((entry) => entry.tokenHash === hashToken(parsed.token));
    if (!invite) {
      appendAudit({
        ts: new Date(now).toISOString(),
        action: 'invite_redeem_failed',
        reason: 'missing_or_expired',
        senderId: maskId(senderId),
        tokenPreview: tokenPreview(parsed.token)
      });
      return {
        handled: true,
        responseText: 'This media invite link is invalid or expired.',
        outcome: 'missing_or_expired'
      };
    }

    const sender = normalizeId(senderId);
    if (!sender) {
      return {
        handled: true,
        responseText: 'This media invite link is invalid or expired.',
        outcome: 'invalid_sender'
      };
    }

    const { cfg, telegram, mediaRequestUserIds, fullAccessUserIds } = readAccessConfig();
    if (!mediaRequestUserIds.includes(sender)) mediaRequestUserIds.push(sender);
    cfg.telegram = {
      ...telegram,
      fullAccessUserIds: fullAccessUserIds,
      mediaRequestUserIds
    };
    writeAccessConfig(cfg);

    state.pendingInvites = state.pendingInvites.filter((entry) => entry.tokenHash !== invite.tokenHash);
    state.activeUsers = state.activeUsers.filter((entry) => entry.userId !== sender && entry.labelKey !== invite.labelKey);
    state.activeUsers.push({
      label: invite.label,
      labelKey: invite.labelKey,
      userId: sender,
      addedAt: new Date(now).toISOString(),
      createdBy: invite.createdBy,
      createdByMasked: invite.createdByMasked,
      inviteCreatedAt: invite.createdAt
    });
    writeState(state);
    appendAudit({
      ts: new Date(now).toISOString(),
      action: 'invite_redeemed',
      label: invite.label,
      senderId: maskId(sender),
      createdBy: invite.createdByMasked,
      tokenPreview: invite.tokenPreview
    });

    return {
      handled: true,
      responseText: 'Media-only access enabled. Use /movie <title>, /show <title>, or /mediahelp.',
      outcome: 'redeemed',
      label: invite.label,
      userId: sender
    };
  });
}

export {
  INVITE_TTL_MS,
  TOKEN_PREFIX,
  buildInviteDeepLink,
  createMediaInvite,
  isDirectMessage,
  listMediaUsers,
  maskId,
  parseAdminCommand,
  parseInviteRedemptionText,
  readAccessConfig,
  readState,
  redeemMediaInvite,
  revokeMediaAccess,
  writeAccessConfig,
  writeJsonAtomic,
  writeState
};
