import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REGISTRY_PATH = fileURLToPath(new URL('../config/telegram-media-commands.json', import.meta.url));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeCommandName(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text.startsWith('/')) return '';
  return text.split(/\s+/, 1)[0].replace(/@\S+$/, '');
}

function normalizeRegistryCommand(entry) {
  const command = normalizeCommandName(entry?.command);
  const usage = String(entry?.usage || '').trim() || command;
  const description = String(entry?.description || '').trim();
  const kind = String(entry?.kind || '').trim();
  const requestSuffix = String(entry?.requestSuffix || '').trim();
  const targetService = String(entry?.targetService || '').trim();
  if (!command || !usage || !description) {
    throw new Error(`Invalid Telegram media command registry entry in ${REGISTRY_PATH}`);
  }
  return { command, usage, description, kind, requestSuffix, targetService };
}

function loadTelegramMediaCommandRegistry() {
  const raw = readJson(REGISTRY_PATH);
  const telegram = raw.telegram || {};
  const helpIntro = String(telegram.helpIntro || 'Media commands:').trim() || 'Media commands:';
  const stubIntro = String(telegram.stubIntro || 'Media-only access:').trim() || 'Media-only access:';
  const commands = Array.isArray(telegram.commands)
    ? telegram.commands.map(normalizeRegistryCommand)
    : [];
  if (commands.length === 0) {
    throw new Error(`No Telegram media commands defined in ${REGISTRY_PATH}`);
  }
  const byCommand = new Map(commands.map((entry) => [entry.command, entry]));
  return {
    primaryInterface: telegram.primaryInterface === true,
    helpIntro,
    stubIntro,
    commands,
    byCommand,
    path: REGISTRY_PATH
  };
}

function parseTelegramMediaCommand(text) {
  const registry = loadTelegramMediaCommandRegistry();
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return { command: '', arg: '', entry: null, registry };
  const firstToken = normalizeCommandName(raw);
  const entry = registry.byCommand.get(firstToken) || null;
  if (!entry) return { command: '', arg: '', entry: null, registry };
  const arg = raw.slice(raw.split(/\s+/, 1)[0].length).trim();
  return { command: entry.command, arg, entry, registry };
}

function buildTelegramMediaHelpText(registry = loadTelegramMediaCommandRegistry()) {
  const usages = registry.commands.map((entry) => entry.usage).join(', ');
  return `${registry.helpIntro} ${usages}`;
}

function buildTelegramMediaStubText(registry = loadTelegramMediaCommandRegistry()) {
  const commands = registry.commands.map((entry) => entry.command).join(', ');
  return `${registry.stubIntro} use ${commands}.`;
}

export {
  buildTelegramMediaHelpText,
  buildTelegramMediaStubText,
  loadTelegramMediaCommandRegistry,
  normalizeCommandName,
  parseTelegramMediaCommand
};
