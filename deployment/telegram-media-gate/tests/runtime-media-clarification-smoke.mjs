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
const SYNTHETIC_CHAT_ID = '-900000000000004';
const APPROVED_FAILURE_KEYS = ['category', 'errorClass', 'phase', 'status'];
const FORBIDDEN_FAILURE_KEYS = ['apiKey', 'url', 'responseBody', 'token', 'userId', 'senderId', 'chatId', 'message', 'stack'];
const runnerInputs = [];
const sensitiveFailureFields = {
  apiKey: 'sensitive-api-key-value',
  url: 'sensitive-url-value',
  responseBody: 'sensitive-response-body-value',
  token: 'sensitive-token-value',
  userId: MEDIA_ONLY_USER_ID,
  message: 'sensitive-exception-message-value',
  stack: 'sensitive-stack-value'
};
const SENSITIVE_SURFACE_VALUES = [...new Set([
  ...Object.values(sensitiveFailureFields),
  FULL_ACCESS_USER_ID,
  MEDIA_ONLY_USER_ID,
  UNKNOWN_USER_ID
])];

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
function assertNoSensitiveSurface(value, label) {
  const serialized = JSON.stringify(value);
  for (const sensitiveValue of SENSITIVE_SURFACE_VALUES) {
    assert.ok(!serialized.includes(sensitiveValue), `${label} leaked sensitive value: ${sensitiveValue}`);
  }
}
function exactValuePaths(value, target, currentPath = '') {
  if (value === target) return [currentPath];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => exactValuePaths(entry, target, `${currentPath}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) =>
      exactValuePaths(entry, target, currentPath ? `${currentPath}.${key}` : key));
  }
  return [];
}
function assertSenderIdBoundaries(accessConfig, requestEnvelope, state, outwardSurfaces) {
  assert.deepEqual(accessConfig.telegram.mediaRequestUserIds, [MEDIA_ONLY_USER_ID]);
  assert.equal(requestEnvelope.senderId, MEDIA_ONLY_USER_ID);
  assert.notEqual(requestEnvelope.chatId, MEDIA_ONLY_USER_ID);
  assert.deepEqual(
    exactValuePaths({ accessConfig, requestEnvelope, state, outwardSurfaces }, MEDIA_ONLY_USER_ID).sort(),
    [
      'accessConfig.telegram.mediaRequestUserIds[0]',
      'requestEnvelope.senderId',
      'state.recentRequests[0].userId',
      'state.requestHistory[0].userId'
    ]
  );
  assertNoSensitiveSurface(outwardSurfaces, 'outward surface');
}
function assertSanitized(result, log, expectedFailure, accessConfig, requestEnvelope) {
  assert.deepEqual(log.failure, expectedFailure);
  assert.deepEqual(Object.keys(log.failure).sort(), APPROVED_FAILURE_KEYS);
  for (const key of FORBIDDEN_FAILURE_KEYS) {
    assert.ok(!Object.hasOwn(log.failure, key), `failure metadata exposed prohibited key: ${key}`);
  }
  assert.equal(log.responseText, result.responseText);
  assert.equal(log.userId, `...${MEDIA_ONLY_USER_ID.slice(-4)}`);
  assert.notEqual(log.userId, MEDIA_ONLY_USER_ID);
  assert.equal(log.chatId, SYNTHETIC_CHAT_ID);
  assert.notEqual(log.chatId, MEDIA_ONLY_USER_ID);
  assertNoSensitiveSurface(log.failure, 'failure metadata');
  assertNoSensitiveSurface(result.responseText, 'user-facing reply');
  assertNoSensitiveSurface(log, 'audit log');
  assertSenderIdBoundaries(accessConfig, requestEnvelope, readState(), {
    responseText: result.responseText,
    failure: log.failure,
    audit: log
  });
}

try {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const accessConfig = { telegram: {
    fullAccessUserIds: [FULL_ACCESS_USER_ID],
    mediaRequestUserIds: [MEDIA_ONLY_USER_ID],
    unknownUserAction: 'ignore'
  }};
  fs.writeFileSync(configPath, JSON.stringify(accessConfig, null, 2) + '\n');

  const gateUrl = pathToFileURL(path.join(runtimeRoot, 'telegram-media-gate.mjs')).href;
  const handlerUrl = pathToFileURL(path.join(runtimeRoot, 'telegram-media-handler.mjs')).href;
  const { evaluateTelegramMediaAccess } = await import(gateUrl);
  const { handleTelegramMediaCommand } = await import(handlerUrl);
  const mediaHandler = (text, options = {}) =>
    handleTelegramMediaCommand(text, { ...options, runner });
  let requestEnvelope = null;
  const mediaAccess = (text, senderId = MEDIA_ONLY_USER_ID) => {
    requestEnvelope = {
      provider: 'telegram', senderId, chatId: SYNTHETIC_CHAT_ID, text
    };
    return evaluateTelegramMediaAccess({ ...requestEnvelope, mediaHandler });
  };

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
    { phase: 'lookup', category: 'HTTP 5xx', status: 503, errorClass: 'Response' }, accessConfig, requestEnvelope);

  resetMutableData();
  result = await mediaAccess('/movie broken library');
  assert.equal(result.responseText,
    "Radarr answered the lookup, but I couldn't check the library right now. Try again later.");
  assertSanitized(result, readLogs().at(-1),
    { phase: 'library', category: 'timeout', status: null, errorClass: 'TimeoutError' }, accessConfig, requestEnvelope);
} finally {
  if (previousDataRoot === undefined) delete process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT;
  else process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT = previousDataRoot;
  globalThis.fetch = previousFetch;
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

console.log('runtime media clarification smoke passed');
