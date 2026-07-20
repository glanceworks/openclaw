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
const resolverConfigPath = path.join(dataRoot, 'config', 'media-request-mvp.json');
const statePath = path.join(dataRoot, 'state', 'telegram-media-runtime.json');
const logPath = path.join(dataRoot, 'logs', 'telegram-media-requests.jsonl');
const previousDataRoot = process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT;
const previousFetch = globalThis.fetch;
process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT = dataRoot;

const FULL_ACCESS_USER_ID = '900000000000001';
const MEDIA_ONLY_USER_ID = '900000000000002';
const UNKNOWN_USER_ID = '900000000000003';
const SYNTHETIC_CHAT_ID = '-900000000000004';
const APPROVED_FAILURE_KEYS = ['category', 'errorClass', 'phase', 'status'];
const FORBIDDEN_FAILURE_KEYS = ['apiKey', 'url', 'responseBody', 'token', 'userId', 'senderId', 'chatId', 'message', 'stack'];
const runnerInputs = [];
const resolverFetches = [];
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

const dragonsCandidates = [
  { title: 'Dragons', year: 2012, type: 'series' },
  { title: 'Dragons: Race to the Edge', year: 2015, type: 'series' }
];
const dragonsRealSonarrShape = [
  {
    title: 'Dragons', year: 2012, firstAired: '2012-08-07T00:00:00Z',
    seriesType: 'standard', tvdbId: 261202, tmdbId: 44305,
    imdbId: 'tt2325846', titleSlug: 'dragons',
    seasons: [0, 1, 2, 3, 4, 5, 6, 7, 8]
      .map(seasonNumber => ({ seasonNumber, monitored: seasonNumber !== 0 }))
  },
  {
    title: 'Inspector Gadget (2015)', year: 2015, firstAired: '2015-01-05T00:00:00Z',
    tvdbId: 290688, titleSlug: 'inspector-gadget-2015', seriesType: 'standard'
  },
  {
    title: 'Chaos Dragon', year: 2015, firstAired: '2015-07-02T00:00:00Z',
    tvdbId: 296764, titleSlug: 'chaos-dragon', seriesType: 'standard'
  },
  {
    title: 'Dragons: The Nine Realms', year: 2021, firstAired: '2021-12-23T00:00:00Z',
    tvdbId: 411408, titleSlug: 'dragons-the-nine-realms', seriesType: 'standard'
  },
  {
    title: 'Dragons: Rescue Riders', year: 2019, firstAired: '2019-09-27T00:00:00Z',
    tvdbId: 370115, titleSlug: 'dragons-rescue-riders', seriesType: 'standard'
  }
];
const sonarrLookup = {
  'dragons race to the edge': dragonsRealSonarrShape
};
function normalizeLookupTerm(value) {
  return String(value || '').toLowerCase().replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function fixtureResponse(data) {
  return { status: 200, ok: true, async text() { return JSON.stringify(data); } };
}
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const method = String(options.method || 'GET').toUpperCase();
  resolverFetches.push({ hostname: parsed.hostname, pathname: parsed.pathname, method });
  assert.equal(method, 'GET', 'the resolver smoke must not exercise media add operations');
  if (parsed.hostname === 'fixture-sonarr' && parsed.pathname === '/api/v3/series/lookup') {
    return fixtureResponse(sonarrLookup[normalizeLookupTerm(parsed.searchParams.get('term'))] || []);
  }
  if (parsed.hostname === 'fixture-sonarr' && parsed.pathname === '/api/v3/series') {
    return fixtureResponse([]);
  }
  if (parsed.hostname === 'fixture-radarr' && parsed.pathname === '/api/v3/movie/lookup') {
    return fixtureResponse([]);
  }
  if (parsed.hostname === 'fixture-radarr' && parsed.pathname === '/api/v3/movie') {
    return fixtureResponse([]);
  }
  throw new Error(`network access is forbidden; unexpected fixture URL: ${url}`);
};

function lowConfidence(title = 'Dragons: Race to the Edge') {
  return {
    resolverState: 'low_confidence',
    addResult: 'not_attempted',
    matchedTitle: `${title} (2015)`,
    candidates: title === 'Dragons: Race to the Edge'
      ? dragonsCandidates
      : [{ title, year: 2015, type: 'series' }]
  };
}

function lookupFailure(status, category) {
  return {
    resolverState: 'lookup_error',
    addResult: 'not_attempted',
    matchedTitle: null,
    candidates: [],
    failure: {
      phase: 'lookup', category, status, errorClass: 'Response',
      ...sensitiveFailureFields
    }
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
  if (query === 'dragons: race to the edge 2015 show') return {
    resolverState: 'resolved', addResult: 'success',
    matchedTitle: 'Dragons: Race to the Edge (2015)', candidates: []
  };
  if (query === 'dragons 2015 show' || query === 'dragons show') return {
    resolverState: 'ambiguous', addResult: 'not_attempted', matchedTitle: null,
    candidates: dragonsCandidates
  };
  if (query === 'race to the edge 2015 show') return lowConfidence('Race to the Edge');
  if (query === 'broken lookup show') return lookupFailure(503, 'HTTP 5xx');
  if (query === 'broken status 401 show') return lookupFailure(401, 'HTTP 401/403');
  if (query === 'broken status 404 show') return lookupFailure(404, 'HTTP 404');
  if (query === 'broken status 500 show') return lookupFailure(500, 'HTTP 5xx');
  if (query === 'broken status numeric string show') return lookupFailure('401', 'HTTP 401/403');
  if (query === 'broken status nan show') return lookupFailure(Number.NaN, 'other');
  if (query === 'broken status infinity show') return lookupFailure(Number.POSITIVE_INFINITY, 'other');
  if (query === 'broken status secret show') return lookupFailure(sensitiveFailureFields.token, 'other');
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
  fs.writeFileSync(resolverConfigPath, JSON.stringify({
    sonarr: { baseUrl: 'http://fixture-sonarr', apiKey: 'fixture-sonarr-key' },
    radarr: { baseUrl: 'http://fixture-radarr', apiKey: 'fixture-radarr-key' }
  }, null, 2) + '\n');

  const gateUrl = pathToFileURL(path.join(runtimeRoot, 'telegram-media-gate.mjs')).href;
  const handlerUrl = pathToFileURL(path.join(runtimeRoot, 'telegram-media-handler.mjs')).href;
  const resolverUrl = pathToFileURL(path.join(runtimeRoot, 'media-mvp-resolve.mjs')).href;
  const { evaluateTelegramMediaAccess } = await import(gateUrl);
  const { handleTelegramMediaCommand } = await import(handlerUrl);
  const { resolveRequest, summarize } = await import(resolverUrl);
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

  for (const query of [
    'Dragons: Race to the Edge (2015) show',
    'Dragons: Race to the Edge 2015 show'
  ]) {
    const resolved = await resolveRequest(query);
    const summary = summarize(resolved);
    assert.equal(summary.classification, 'series');
    assert.equal(summary.targetService, 'sonarr');
    assert.equal(summary.resolutionState, 'resolved');
    assert.equal(summary.matchedTitle, 'Dragons: Race to the Edge (2015)');
    assert.equal(resolved.candidate.item.title, 'Dragons');
    assert.equal(resolved.candidate.item.year, 2012);
    assert.equal(resolved.candidate.item.tvdbId, 261202);
  }
  const weakYearResult = await resolveRequest('Dragons: Race to the Edge (2012) show');
  const weakYearSummary = summarize(weakYearResult);
  assert.equal(weakYearSummary.classification, 'series');
  assert.equal(weakYearSummary.targetService, 'sonarr');
  assert.equal(weakYearSummary.resolutionState, 'low_confidence');
  assert.equal(weakYearSummary.matchedTitle, 'Dragons (2012)');
  assert.equal(weakYearResult.candidate.item.title, 'Dragons');
  assert.equal(resolverFetches.length, 5);
  assert.ok(resolverFetches.every(({ hostname, method }) =>
    hostname === 'fixture-sonarr' && method === 'GET'));

  resetMutableData();
  let result = await mediaAccess('/show Dragons: Race to the Edge (2015)');
  assert.equal(result.decision, 'intercept_media_only');
  assert.equal(result.reason, 'media_request_user');
  assert.equal(runnerInputs.at(-1), 'Dragons: Race to the Edge 2015 show');
  assert.equal(result.responseText, 'Dragons: Race to the Edge (2015) added to Sonarr.');
  assert.equal(readState().pendingClarifications.length, 0);

  resetMutableData();
  result = await mediaAccess('/show Dragons: Race to the Edge 2015');
  assert.equal(runnerInputs.at(-1), 'Dragons: Race to the Edge 2015 show');
  assert.equal(result.responseText, 'Dragons: Race to the Edge (2015) added to Sonarr.');
  assert.equal(readState().pendingClarifications.length, 0);

  resetMutableData();
  result = await mediaAccess('/show Dragons 2015');
  assert.match(result.responseText,
    /1\. Dragons \(2012\) show; 2\. Dragons: Race to the Edge \(2015\) show/);
  assertCanonical({ title: 'Dragons', year: 2015, mediaType: 'show' });
  const beforeNoProgressCount = runnerInputs.length;
  const firstPrompt = result.responseText;

  result = await mediaAccess('2015');
  assert.equal(runnerInputs.length, beforeNoProgressCount);
  assert.match(result.responseText, /I already have 2015 for Dragons 2015/);
  assert.match(result.responseText, /Reply with a number or a more specific title/);
  assert.notEqual(result.responseText, firstPrompt);
  assert.equal(readLogs().at(-1).outcome, 'pending_no_progress');
  assertCanonical({ title: 'Dragons', year: 2015, mediaType: 'show' });

  const firstNoProgressPrompt = result.responseText;
  result = await mediaAccess('2015');
  assert.equal(runnerInputs.length, beforeNoProgressCount);
  assert.notEqual(result.responseText, firstNoProgressPrompt);
  assert.match(result.responseText, /Still no change/);
  assert.equal(readLogs().at(-1).outcome, 'pending_no_progress');
  assertCanonical({ title: 'Dragons', year: 2015, mediaType: 'show' });

  result = await mediaAccess('9');
  assert.equal(runnerInputs.length, beforeNoProgressCount);
  assert.match(result.responseText, /isn't a valid selection/);
  assert.match(result.responseText,
    /1\. Dragons \(2012\) show; 2\. Dragons: Race to the Edge \(2015\) show/);
  assert.equal(readLogs().at(-1).outcome, 'pending_invalid_selection');

  result = await mediaAccess('2');
  assert.equal(runnerInputs.at(-1), 'Dragons: Race to the Edge 2015 show');
  assert.equal(result.responseText, 'Dragons: Race to the Edge (2015) added to Sonarr.');
  assert.equal(readState().pendingClarifications.length, 0);

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

  for (const [command, category, status] of [
    ['/show broken status 401', 'HTTP 401/403', 401],
    ['/show broken status 404', 'HTTP 404', 404],
    ['/show broken status 500', 'HTTP 5xx', 500]
  ]) {
    resetMutableData();
    result = await mediaAccess(command);
    const httpLog = readLogs().at(-1);
    assertSanitized(result, httpLog,
      { phase: 'lookup', category, status, errorClass: 'Response' }, accessConfig, requestEnvelope);
    assert.equal(typeof httpLog.failure.status, 'number');
    assert.ok(Number.isFinite(httpLog.failure.status));
  }

  resetMutableData();
  result = await mediaAccess('/show broken status numeric string');
  const numericStringLog = readLogs().at(-1);
  assertSanitized(result, numericStringLog,
    { phase: 'lookup', category: 'HTTP 401/403', status: 401, errorClass: 'Response' }, accessConfig, requestEnvelope);
  assert.equal(typeof numericStringLog.failure.status, 'number');

  for (const command of [
    '/show broken status nan',
    '/show broken status infinity',
    '/show broken status secret'
  ]) {
    resetMutableData();
    result = await mediaAccess(command);
    const invalidStatusLog = readLogs().at(-1);
    assertSanitized(result, invalidStatusLog,
      { phase: 'lookup', category: 'other', status: null, errorClass: 'Response' }, accessConfig, requestEnvelope);
    assert.equal(invalidStatusLog.failure.status, null);
  }

  resetMutableData();
  result = await mediaAccess('/movie broken library');
  assert.equal(result.responseText,
    "Radarr answered the lookup, but I couldn't check the library right now. Try again later.");
  const timeoutLog = readLogs().at(-1);
  // Established runtime contract: Number(null) is 0; 0 means no HTTP status was received.
  assertSanitized(result, timeoutLog,
    { phase: 'library', category: 'timeout', status: 0, errorClass: 'TimeoutError' }, accessConfig, requestEnvelope);
  assert.equal(typeof timeoutLog.failure.status, 'number');
  assert.equal(timeoutLog.failure.status, 0);
} finally {
  if (previousDataRoot === undefined) delete process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT;
  else process.env.OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT = previousDataRoot;
  globalThis.fetch = previousFetch;
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

console.log('runtime media clarification smoke passed');
