import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeRoot = path.resolve(
  process.env.OPENCLAW_TELEGRAM_MEDIA_RUNTIME_ROOT
    || fileURLToPath(new URL('../runtime/scripts/', import.meta.url))
);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-media-clarification-'));
const configPath = path.join(dataRoot, 'config', 'telegram-media-access.json');
const statePath = path.join(dataRoot, 'state', 'telegram-media-runtime.json');
const logPath = path.join(dataRoot, 'logs', 'telegram-media-requests.jsonl');
const previousDataRoot = process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT;
const previousFetch = globalThis.fetch;
process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT = dataRoot;
globalThis.fetch = async () => { throw new Error('network access is forbidden in this smoke test'); };

const FULL_ACCESS_USER_ID = '900000000000001';
const MEDIA_ONLY_USER_ID = '900000000000002';
const UNKNOWN_USER_ID = '900000000000003';
const runnerInputs = [];
const sensitiveFailureFields = {
  apiKey: 'sensitive-api-key-value',
  url: 'sensitive-url-value',
  responseBody: 'sensitive-response-body-value',
  token: 'sensitive-token-value',
  userId: MEDIA_ONLY_USER_ID
};

function lowConfidence(title = 'Dragons: Race to the Edge') {
  return {
    resolverState: 'low_confidence',
    addResult: 'not_attempted',
    matchedTitle: `${title} (2015)`,
    candidates: [{ title, year: 2015, type: 'series' }]
  };
}

const runner = async (input) => {
  runnerInputs.push(input);
  const query = String(input || '').trim().toLowerCase();
  if (query === 'strange harvest movie') return {
    resolverState: 'ambiguous', addResult: 'not_attempted', matchedTitle: null,
    candidates: [
      { title: 'Strange Harvest', year: 2024, type: 'movie' },
      { title: 'Strange Harvest', year: 2026, type: 'movie' }
    ]
  };
  if (query === 'strange harvest 2026 movie') return {
    resolverState: 'resolved', addResult: 'success',
    matchedTitle: 'Strange Harvest (2026)', candidates: []
  };
  if (query === 'dragons: race to the edge show') return lowConfidence();
  if (query === 'dragons: race to the edge 2015 show') return lowConfidence();
  if (query === 'race to the edge 2015 show') return lowConfidence('Race to the Edge');
  if (query === 'broken lookup show') return {
    resolverState: 'lookup_error', addResult: 'not_attempted', matchedTitle: null,
    candidates: [], failure: {
      phase: 'lookup', category: 'HTTP 5xx', status: 503, errorClass: 'Response',
      ...sensitiveFailureFields
    }
  };
  if (query === 'broken library movie') return {
    resolverState: 'library_error', addResult: 'not_attempted', matchedTitle: null,
    candidates: [], failure: {
      phase: 'library', category: 'timeout', status: null, errorClass: 'TimeoutError',
      ...sensitiveFailureFields
    }
  };
  throw new Error(`unexpected stubbed runner input: ${input}`);
};

function readState() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}
function readLogs() {
  return fs.readFileSync(logPath, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
}
function resetMutableData() {
  fs.rmSync(statePath, { force: true });
  fs.rmSync(logPath, { force: true });
  runnerInputs.length = 0;
}
function assertCanonical(expected) {
  const canonical = readState().pendingClarifications[0].canonical;
  assert.deepEqual(Object.keys(canonical).sort(), ['mediaType', 'title', 'year']);
  assert.deepEqual(canonical, expected);
  assert.notEqual(canonical.title, '2015 2015');
}
function assertSanitized(result, log, expectedFailure) {
  assert.deepEqual(log.failure, expectedFailure);
  assert.deepEqual(Object.keys(log.failure).sort(), ['category', 'errorClass', 'phase', 'status']);
  const serialized = JSON.stringify({ result, log });
  for (const value of Object.values(sensitiveFailureFields)) {
    assert.ok(!serialized.includes(value), `sensitive value leaked: ${value}`);
  }
}

try {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ telegram: {
    fullAccessUserIds: [FULL_ACCESS_USER_ID],
    mediaRequestUserIds: [MEDIA_ONLY_USER_ID],
    unknownUserAction: 'ignore'
  }}, null, 2) + '\n');

  const gateUrl = pathToFileURL(path.join(runtimeRoot, 'telegram-media-gate.mjs')).href;
  const handlerUrl = pathToFileURL(path.join(runtimeRoot, 'telegram-media-handler.mjs')).href;
  const { evaluateTelegramMediaAccess } = await import(gateUrl);
  const { handleTelegramMediaCommand } = await import(handlerUrl);
  const mediaHandler = (text, options = {}) =>
    handleTelegramMediaCommand(text, { ...options, runner });
  const mediaAccess = (text, senderId = MEDIA_ONLY_USER_ID) => evaluateTelegramMediaAccess({
    provider: 'telegram', senderId, chatId: senderId, text, mediaHandler
  });

  resetMutableData();
  const unknownResult = await mediaAccess('/show Dragons: Race to the Edge (2015)', UNKNOWN_USER_ID);
  assert.equal(unknownResult.decision, 'ignore');
  assert.equal(unknownResult.reason, 'unknown_user');
  assert.equal(runnerInputs.length, 0);

  resetMutableData();
  let result = await mediaAccess('/show Dragons: Race to the Edge (2015)');
  assert.equal(result.decision, 'intercept_media_only');
  assert.equal(result.reason, 'media_request_user');
  assert.equal(runnerInputs.at(-1), 'Dragons: Race to the Edge 2015 show');
  assert.match(result.responseText, /Dragons: Race to the Edge 2015/);
  assert.doesNotMatch(result.responseText, /2015 2015/);
  assertCanonical({ title: 'Dragons: Race to the Edge', year: 2015, mediaType: 'show' });

  result = await mediaAccess('2015');
  assert.equal(runnerInputs.at(-1), 'Dragons: Race to the Edge 2015 show');
  assert.doesNotMatch(result.responseText, /2015 2015/);
  assertCanonical({ title: 'Dragons: Race to the Edge', year: 2015, mediaType: 'show' });
  result = await mediaAccess('2015');
  assert.equal(runnerInputs.at(-1), 'Dragons: Race to the Edge 2015 show');
  assert.doesNotMatch(result.responseText, /2015 2015/);
  assertCanonical({ title: 'Dragons: Race to the Edge', year: 2015, mediaType: 'show' });

  resetMutableData();
  await mediaAccess('/show Dragons: Race to the Edge 2015');
  assert.equal(runnerInputs.at(-1), 'Dragons: Race to the Edge 2015 show');
  assertCanonical({ title: 'Dragons: Race to the Edge', year: 2015, mediaType: 'show' });

  resetMutableData();
  await mediaAccess('/show Dragons: Race to the Edge');
  result = await mediaAccess('Race to the Edge 2015');
  assert.equal(runnerInputs.at(-1), 'Race to the Edge 2015 show');
  assert.doesNotMatch(result.responseText, /2015 2015/);
  assertCanonical({ title: 'Race to the Edge', year: 2015, mediaType: 'show' });

  resetMutableData();
  await mediaAccess('/movie strange harvest');
  result = await mediaAccess('2026');
  assert.equal(runnerInputs.at(-1), 'strange harvest 2026 movie');
  assert.equal(result.responseText, 'Strange Harvest (2026) added to Radarr.');
  assert.equal(readState().pendingClarifications.length, 0);

  resetMutableData();
  result = await mediaAccess('/show broken lookup');
  assert.equal(result.responseText, 'Sonarr lookup is having trouble right now. Try again later.');
  assertSanitized(result, readLogs().at(-1),
    { phase: 'lookup', category: 'HTTP 5xx', status: 503, errorClass: 'Response' });

  resetMutableData();
  result = await mediaAccess('/movie broken library');
  assert.equal(result.responseText,
    "Radarr answered the lookup, but I couldn't check the library right now. Try again later.");
  assertSanitized(result, readLogs().at(-1),
    { phase: 'library', category: 'timeout', status: null, errorClass: 'TimeoutError' });
} finally {
  if (previousDataRoot === undefined) delete process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT;
  else process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT = previousDataRoot;
  globalThis.fetch = previousFetch;
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

console.log('runtime media clarification smoke passed');
