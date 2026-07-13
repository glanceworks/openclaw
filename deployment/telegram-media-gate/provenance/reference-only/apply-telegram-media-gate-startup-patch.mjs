#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DIST_DIR = '/app/dist';
const PATCH_MARKER = 'OPENCLAW_TELEGRAM_MEDIA_GATE_PATCH_V2';
const LEGACY_PATCH_MARKER = 'OPENCLAW_TELEGRAM_MEDIA_GATE_PATCH_V1';
const GATE_MODULE_URL = 'file:///home/node/.openclaw/workspace-coordinator/scripts/telegram-media-gate.mjs';
const BACKUP_SUFFIX = '.pre-telegram-media-gate.bak';

const HELPER_ANCHOR = `const createTelegramUpdateDedupe = () => createDedupeCache({\n\tttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,\n\tmaxSize: RECENT_TELEGRAM_UPDATE_MAX\n});\n`;
const HANDOFF_ANCHOR = `\t\t\tawait processInboundMessage({\n\t\t\t\tctx: event.ctx,\n\t\t\t\tmsg: event.msg,\n\t\t\t\tchatId: event.chatId,\n\t\t\t\tresolvedThreadId,\n\t\t\t\tdmThreadId,\n\t\t\t\tstoreAllowFrom,\n\t\t\t\tsendOversizeWarning: event.sendOversizeWarning,\n\t\t\t\toversizeLogMessage: event.oversizeLogMessage\n\t\t\t});`;

const helperBlock = `${HELPER_ANCHOR}const TELEGRAM_MEDIA_GATE_PATCH_MARKER = \"${PATCH_MARKER}\";\nconst TELEGRAM_MEDIA_GATE_MODULE_URL = \"${GATE_MODULE_URL}\";\nlet telegramMediaGateModulePromise = null;\nasync function loadTelegramMediaGateModule() {\n\ttelegramMediaGateModulePromise ??= import(TELEGRAM_MEDIA_GATE_MODULE_URL);\n\treturn await telegramMediaGateModulePromise;\n}\nasync function evaluateTelegramMediaGateDecision(params) {\n\ttry {\n\t\tconst mod = await loadTelegramMediaGateModule();\n\t\tif (!mod || typeof mod.evaluateTelegramMediaAccess !== \"function\") return null;\n\t\treturn mod.evaluateTelegramMediaAccess({\n\t\t\tprovider: \"telegram\",\n\t\t\tsenderId: params.senderId,\n\t\t\tchatId: params.chatId,\n\t\t\ttext: params.text,\n\t\t\tbotUsername: params.botUsername\n\t\t});\n\t} catch (err) {\n\t\tparams.runtime?.error?.(danger(\`telegram media gate load failed: \${String(err)}\`));\n\t\treturn null;\n\t}\n}\nasync function applyTelegramMediaGateDecision(params) {\n\tconst decision = await evaluateTelegramMediaGateDecision({\n\t\tchatId: params.chatId,\n\t\tsenderId: params.senderId,\n\t\ttext: params.text,\n\t\tbotUsername: params.bot?.botInfo?.username ?? null,\n\t\truntime: params.runtime\n\t});\n\tif (!decision) return false;\n\tif (decision.decision === \"continue_normal\") return false;\n\tif (decision.decision === \"intercept_media_only\" || decision.decision === \"deny\") {\n\t\tif (decision.responseText) await withTelegramApiErrorLogging({\n\t\t\toperation: \"sendMessage\",\n\t\t\truntime: params.runtime,\n\t\t\tfn: () => params.bot.api.sendMessage(params.chatId, decision.responseText, params.threadParams)\n\t\t});\n\t\treturn true;\n\t}\n\tif (decision.decision === \"ignore\") return true;\n\treturn false;\n}\n`;

const legacyHelperBlock = helperBlock
  .replace(PATCH_MARKER, LEGACY_PATCH_MARKER)
  .replace('\t\t\tchatId: params.chatId,\n', '')
  .replace('\t\tchatId: params.chatId,\n', '');

const handoffBlock = `\t\t\tif (await applyTelegramMediaGateDecision({\n\t\t\t\tbot,\n\t\t\t\truntime,\n\t\t\t\tchatId: event.chatId,\n\t\t\t\tsenderId: event.senderId,\n\t\t\t\ttext: event.msg.text ?? event.msg.caption ?? \"\",\n\t\t\t\tthreadParams: buildTelegramThreadParams(resolveTelegramThreadSpec({\n\t\t\t\t\tisGroup: event.isGroup,\n\t\t\t\t\tisForum: event.isForum,\n\t\t\t\t\tmessageThreadId: event.messageThreadId\n\t\t\t\t}))\n\t\t\t})) return;\n${HANDOFF_ANCHOR}`;

const legacyHandoffBlock = handoffBlock;

function listCandidateFiles() {
  return fs.readdirSync(DIST_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(DIST_DIR, name));
}

function isTelegramInboundChunk(text) {
  return text.includes('const handleInboundMessageLike = async (event) => {') &&
    text.includes('await processInboundMessage({') &&
    text.includes('bot.on("message", async (ctx) => {') &&
    text.includes('createTelegramBot');
}

function backupPathFor(filePath) {
  return `${filePath}${BACKUP_SUFFIX}`;
}

function patchFile(filePath, { dryRun = false } = {}) {
  const original = fs.readFileSync(filePath, 'utf8');
  if (!isTelegramInboundChunk(original)) return { filePath, status: 'skip-not-candidate' };
  if (original.includes(PATCH_MARKER)) return { filePath, status: 'already-patched' };

  let patched = original;
  if (original.includes(LEGACY_PATCH_MARKER)) {
    if (!original.includes(legacyHelperBlock) || !original.includes(legacyHandoffBlock)) {
      throw new Error(`legacy patch blocks not found in ${filePath}`);
    }
    patched = original
      .replace(legacyHelperBlock, helperBlock)
      .replace(legacyHandoffBlock, handoffBlock);
  } else {
    if (!original.includes(HELPER_ANCHOR)) {
      throw new Error(`helper anchor not found in ${filePath}`);
    }
    if (!original.includes(HANDOFF_ANCHOR)) {
      throw new Error(`handoff anchor not found in ${filePath}`);
    }
    patched = original
      .replace(HELPER_ANCHOR, helperBlock)
      .replace(HANDOFF_ANCHOR, handoffBlock);
  }

  if (!patched.includes(PATCH_MARKER)) {
    throw new Error(`patch marker missing after patch in ${filePath}`);
  }
  if (!dryRun) {
    const backupPath = backupPathFor(filePath);
    if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, original);
    fs.writeFileSync(filePath, patched);
  }
  return { filePath, status: 'patched' };
}

function restoreFile(filePath, { dryRun = false } = {}) {
  const backupPath = backupPathFor(filePath);
  if (!fs.existsSync(backupPath)) return { filePath, status: 'no-backup' };
  if (!dryRun) {
    fs.copyFileSync(backupPath, filePath);
  }
  return { filePath, status: 'restored' };
}

export function applyStartupPatch({ dryRun = false, failIfNoCandidates = true } = {}) {
  const files = listCandidateFiles();
  const results = files.map((filePath) => patchFile(filePath, { dryRun }));
  const touched = results.filter((r) => r.status === 'patched' || r.status === 'already-patched');
  const newlyPatched = results.filter((r) => r.status === 'patched');
  if (failIfNoCandidates && touched.length === 0) {
    throw new Error('No Telegram inbound handler chunks matched expected patterns in /app/dist');
  }
  return { results, touched, newlyPatched, patchMarker: PATCH_MARKER };
}

export function rollbackStartupPatch({ dryRun = false } = {}) {
  const files = listCandidateFiles();
  const results = files.map((filePath) => restoreFile(filePath, { dryRun }));
  return { results, patchMarker: PATCH_MARKER };
}

function printSummary(summary) {
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] || 'apply';
  const dryRun = process.argv.includes('--dry-run');
  if (mode === 'apply') {
    printSummary(applyStartupPatch({ dryRun }));
  } else if (mode === 'rollback') {
    printSummary(rollbackStartupPatch({ dryRun }));
  } else {
    console.error('Usage: node scripts/apply-telegram-media-gate-startup-patch.mjs [apply|rollback] [--dry-run]');
    process.exit(2);
  }
}
