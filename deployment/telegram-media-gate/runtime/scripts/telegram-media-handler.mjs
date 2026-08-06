import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { runOne } from './media-mvp-add-gated.mjs';
import {
  buildTelegramMediaHelpText,
  parseTelegramMediaCommand
} from './telegram-media-command-registry.mjs';
import { maskId, writeJsonAtomic } from './telegram-media-invite.mjs';
import {
  getTelegramMediaRequestsLogPath,
  getTelegramMediaRuntimeStatePath
} from './telegram-media-paths.mjs';

const DEDUPE_WINDOW_MS = 2 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const PENDING_TTL_MS = 15 * 60 * 1000;

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function getStatePath() {
  return getTelegramMediaRuntimeStatePath();
}

function getLogPath() {
  return getTelegramMediaRequestsLogPath();
}

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(getStatePath(), 'utf8'));
    return {
      requestHistory: Array.isArray(state.requestHistory) ? state.requestHistory : [],
      recentRequests: Array.isArray(state.recentRequests) ? state.recentRequests : [],
      pendingClarifications: Array.isArray(state.pendingClarifications) ? state.pendingClarifications : []
    };
  } catch {
    return { requestHistory: [], recentRequests: [], pendingClarifications: [] };
  }
}

function writeState(state) {
  const statePath = getStatePath();
  ensureParent(statePath);
  writeJsonAtomic(statePath, state);
}

function appendLog(entry) {
  const logPath = getLogPath();
  ensureParent(logPath);
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

function requestKey(userId, command, arg) {
  return crypto.createHash('sha1').update(`${userId}|${command}|${arg.trim().toLowerCase()}`).digest('hex');
}

function normalizeChatId(value) {
  return String(value || '').trim();
}

function pendingScope(userId, chatId) {
  return `${String(userId || '').trim() || 'unknown'}|${normalizeChatId(chatId) || 'direct'}`;
}

function pruneState(state, now) {
  state.requestHistory = (state.requestHistory || []).filter((item) => now - Number(item.ts || 0) <= RATE_LIMIT_WINDOW_MS);
  state.recentRequests = (state.recentRequests || []).filter((item) => now - Number(item.ts || 0) <= DEDUPE_WINDOW_MS);
  state.pendingClarifications = (state.pendingClarifications || []).filter((item) => now - Number(item.ts || 0) <= PENDING_TTL_MS);
  return state;
}

function activePendingFor(state, userId, chatId) {
  const scope = pendingScope(userId, chatId);
  return (state.pendingClarifications || []).find((item) => item.scope === scope) || null;
}

function clearPendingFor(state, userId, chatId) {
  const scope = pendingScope(userId, chatId);
  state.pendingClarifications = (state.pendingClarifications || []).filter((item) => item.scope !== scope);
}

function upsertPending(state, pending) {
  clearPendingFor(state, pending.userId, pending.chatId);
  state.pendingClarifications.push(pending);
}

function formatCandidate(candidate) {
  const title = String(candidate?.title || candidate?.matchedTitle || '').trim();
  const year = candidate?.year ? ` (${candidate.year})` : '';
  const type = candidate?.type === 'series' ? ' show' : candidate?.type === 'movie' ? ' movie' : '';
  return title ? `${title}${year}${type}` : '';
}

function candidateOptionsText(candidates) {
  const unique = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const label = formatCandidate(candidate);
    if (label && !unique.includes(label)) unique.push(label);
    if (unique.length >= 4) break;
  }
  return unique;
}

function candidateOptionObjects(candidates) {
  const unique = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const label = formatCandidate(candidate);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    unique.push({
      title: String(candidate?.title || candidate?.matchedTitle || '').trim(),
      year: candidate?.year ? Number(candidate.year) : null,
      type: candidate?.type === 'series' ? 'series' : candidate?.type === 'movie' ? 'movie' : null,
      label
    });
    if (unique.length >= 4) break;
  }
  return unique;
}

function parseNumberedSelection(text, candidates) {
  const match = String(text || '').trim().match(/^\d{1,2}$/);
  if (!match) return { kind: 'none' };
  const index = Number(match[0]);
  const options = candidateOptionObjects(candidates);
  if (index >= 1 && index <= options.length) return { kind: 'valid', index, candidate: options[index - 1], count: options.length };
  return { kind: 'invalid', index, count: options.length };
}

function parseTitleYear(text) {
  const raw = String(text || '').trim().replace(/\s+/g, ' ');
  const parenMatch = raw.match(/^(.*?)\s*\((19\d{2}|20\d{2}|21\d{2})\)\s*$/);
  const trailingMatch = raw.match(/^(.*?)\s+(19\d{2}|20\d{2}|21\d{2})\s*$/);
  const match = parenMatch || trailingMatch;
  if (match) {
    return { title: match[1].trim(), year: Number(match[2]) };
  }
  return { title: raw, year: null };
}

function canonicalFromQuery(query, mediaType) {
  const parsed = parseTitleYear(query);
  return {
    title: parsed.title || String(query || '').trim(),
    year: parsed.year,
    mediaType: mediaType === 'show' ? 'show' : 'movie'
  };
}

function mergeClarificationIntoCanonical(pending, clarification) {
  const current = pending?.canonical && typeof pending.canonical === 'object'
    ? {
        title: String(pending.canonical.title || pending.originalQuery || '').trim(),
        year: pending.canonical.year ? Number(pending.canonical.year) : null,
        mediaType: pending.canonical.mediaType === 'show' ? 'show' : 'movie'
      }
    : canonicalFromQuery(pending?.originalQuery || '', pending?.mediaType || 'movie');
  const text = String(clarification || '').trim().replace(/\s+/g, ' ');
  const bareYear = text.match(/^(19\d{2}|20\d{2}|21\d{2})$/);
  if (bareYear) {
    return { ...current, year: Number(bareYear[1]) };
  }
  const parsed = parseTitleYear(text);
  return {
    ...current,
    title: parsed.title || current.title,
    year: parsed.year || current.year || null
  };
}

function canonicalQueryText(canonical, includeMediaType = false) {
  const title = String(canonical?.title || '').trim().replace(/\s+/g, ' ');
  const year = canonical?.year ? ` ${Number(canonical.year)}` : '';
  const mediaType = includeMediaType ? ` ${canonical?.mediaType === 'show' ? 'show' : 'movie'}` : '';
  return `${title}${year}${mediaType}`.trim();
}

function canonicalEquals(a, b) {
  return canonicalQueryText(a, true).toLowerCase() === canonicalQueryText(b, true).toLowerCase();
}

function safeFailureForLog(result) {
  const failure = result?.failure;
  if (!failure || typeof failure !== 'object') return null;
  return {
    phase: failure.phase === 'library' ? 'library' : failure.phase === 'lookup' ? 'lookup' : 'unknown',
    category: String(failure.category || 'other').slice(0, 40),
    status: Number.isFinite(Number(failure.status)) ? Number(failure.status) : null,
    errorClass: failure.errorClass ? String(failure.errorClass).slice(0, 40) : null
  };
}

function clarificationPrompt(result, pending = null) {
  const options = candidateOptionsText(result.candidates || pending?.candidates || []);
  const query = pending?.canonical ? canonicalQueryText(pending.canonical) : pending?.originalQuery;
  const base = query
    ? `I found multiple likely matches for ${query}.`
    : 'I found multiple likely matches.';
  if (options.length > 0) {
    const numbered = options.map((option, index) => `${index + 1}. ${option}`).join('; ');
    return `${base} Reply with a number, the year, or a more specific title: ${numbered}.`;
  }
  return `${base} Reply with the year or a more specific title.`;
}

function noProgressClarificationPrompt(pending) {
  const query = pending?.canonical ? canonicalQueryText(pending.canonical) : pending?.originalQuery;
  const options = candidateOptionsText(pending?.candidates || []);
  const year = pending?.canonical?.year ? Number(pending.canonical.year) : null;
  const repeated = Number(pending?.noProgressCount || 0) > 1;
  const base = year
    ? `${repeated ? 'Still no change: I' : 'I'} already have ${year}${query ? ` for ${query}` : ''}.`
    : `${repeated ? 'Still no change: t' : 'T'}hat doesn't narrow the media request${query ? ` for ${query}` : ''}.`;
  if (options.length > 0) {
    const numbered = options.map((option, index) => `${index + 1}. ${option}`).join('; ');
    return `${base} Reply with a number or a more specific title: ${numbered}.`;
  }
  return `${base} Reply with a more specific title, or rerun /movie <title> or /show <title>.`;
}

function hasActionableNumberedCandidates(candidates) {
  return candidateOptionsText(candidates || []).length > 0;
}

function knownYearStillUnclearPrompt(canonical, noun) {
  const year = Number(canonical?.year);
  const isShow = canonical?.mediaType === 'show';
  const service = noun || (isShow ? 'Sonarr' : 'Radarr');
  const mediaNoun = isShow ? 'series' : 'movie';
  const retryCommand = isShow ? '/show <exact series title>' : '/movie <exact movie title>';
  const alternate = isShow
    ? 'If this is a film or TV movie, try /movie instead.'
    : 'If this is a series, try /show instead.';
  return `I have ${year}, but ${service} still can’t confidently match that ${mediaNoun} title. Retry with ${retryCommand}. ${alternate}`;
}

function invalidSelectionPrompt(pending, selection) {
  const options = candidateOptionsText(pending?.candidates || []);
  if (options.length > 0) {
    const numbered = options.map((option, index) => `${index + 1}. ${option}`).join('; ');
    return `I only have ${options.length} candidate${options.length === 1 ? '' : 's'} here, so ${selection.index} isn't a valid selection. Reply with one of these: ${numbered}.`;
  }
  return `That number isn't a valid media selection. Reply with a more specific title, or rerun /movie <title> or /show <title>.`;
}

function mapResultToTemplate(result, noun, pending = null) {
  const title = result.matchedTitle || 'that title';
  if (result.resolverState === 'already_exists') {
    return `${title} already exists in ${noun}.`;
  }
  if (result.resolverState === 'already_exists_with_nuance') {
    return result.nuance ? `${title} already exists in ${noun} (${result.nuance}).` : `${title} already exists in ${noun}.`;
  }
  if (result.resolverState === 'ambiguous' || result.resolverState === 'low_confidence') {
    return clarificationPrompt(result, pending);
  }
  if (result.resolverState === 'no_result') {
    return `I couldn't find a match for that title.`;
  }
  if (result.resolverState === 'lookup_error') {
    return `${noun} lookup is having trouble right now. Try again later.`;
  }
  if (result.resolverState === 'library_error') {
    return `${noun} answered the lookup, but I couldn't check the library right now. Try again later.`;
  }
  if (result.addResult === 'failed') {
    return `${noun} couldn't add that title right now.`;
  }
  if (result.addResult === 'success') {
    return `${title} added to ${noun}.`;
  }
  return `${noun} couldn't process that request.`;
}

function buildPendingRecord({ userId, chatId, now, entry, originalQuery, requestText, result, clarificationText = '' }) {
  return {
    scope: pendingScope(userId, chatId),
    userId,
    chatId: normalizeChatId(chatId),
    ts: now,
    mediaType: entry.requestSuffix === 'show' ? 'show' : 'movie',
    originalQuery,
    requestText,
    expectedClarificationType: /^\d{4}$/.test(clarificationText.trim()) ? 'selection' : 'year/title',
    canonical: canonicalFromQuery(originalQuery, entry.requestSuffix === 'show' ? 'show' : 'movie'),
    candidates: candidateOptionsText(result.candidates || []).map((label) => {
      const match = label.match(/^(.*?)(?: \((\d{4})\))?(?: (movie|show))?$/);
      return {
        title: match?.[1] || label,
        year: match?.[2] ? Number(match[2]) : null,
        type: match?.[3] === 'show' ? 'series' : match?.[3] === 'movie' ? 'movie' : null
      };
    })
  };
}

async function executeMediaRequest({ runner, requestText, noun }) {
  try {
    const result = await runner(requestText);
    return {
      ok: true,
      result,
      responseText: mapResultToTemplate(result, noun),
      failure: safeFailureForLog(result)
    };
  } catch (err) {
    return {
      ok: false,
      result: null,
      responseText: `${noun} couldn't process that request right now. Try again later.`,
      failure: { phase: 'runner', category: 'exception', status: null, errorClass: err?.name || err?.constructor?.name || 'Error' }
    };
  }
}

async function handleTelegramMediaCommand(text, options = {}) {
  const userId = String(options.userId || '').trim() || 'unknown';
  const chatId = normalizeChatId(options.chatId);
  const now = Number(options.now || Date.now());
  const runner = typeof options.runner === 'function' ? options.runner : runOne;
  const { command, arg, entry, registry } = parseTelegramMediaCommand(text);
  const state = pruneState(readState(), now);
  const pending = activePendingFor(state, userId, chatId);

  const finalize = (response) => {
    writeState(state);
    appendLog({
      ts: new Date(now).toISOString(),
      userId: maskId(userId),
      chatId: chatId || null,
      command: command || null,
      arg: arg || null,
      outcome: response.auditOutcome,
      responseText: response.responseText,
      failure: response.failure || null
    });
    return { kind: 'handled', responseText: response.responseText };
  };

  if (pending && !command) {
    const clarification = String(text || '').trim();
    if (!clarification) {
      clearPendingFor(state, userId, chatId);
      return finalize({
        auditOutcome: 'pending_missing_clarification',
        responseText: 'That media clarification expired or was incomplete. Rerun /movie <title> or /show <title>.'
      });
    }

    const noun = pending.mediaType === 'show' ? 'Sonarr' : 'Radarr';
    const selection = parseNumberedSelection(clarification, pending.candidates || []);
    if (selection.kind === 'invalid') {
      return finalize({
        auditOutcome: 'pending_invalid_selection',
        responseText: invalidSelectionPrompt(pending, selection)
      });
    }

    const canonical = selection.kind === 'valid'
      ? {
          title: selection.candidate.title,
          year: selection.candidate.year,
          mediaType: pending.mediaType === 'show' ? 'show' : 'movie'
        }
      : mergeClarificationIntoCanonical(pending, clarification);

    if (selection.kind !== 'valid' && canonicalEquals(canonical, pending.canonical || canonicalFromQuery(pending.originalQuery, pending.mediaType))) {
      pending.noProgressCount = Number(pending.noProgressCount || 0) + 1;
      pending.ts = now;
      return finalize({
        auditOutcome: 'pending_no_progress',
        responseText: noProgressClarificationPrompt(pending)
      });
    }

    const requestText = canonicalQueryText(canonical, true);
    const executed = await executeMediaRequest({ runner, requestText, noun });
    if (!executed.ok) {
      clearPendingFor(state, userId, chatId);
      return finalize({ auditOutcome: 'backend_unavailable', responseText: executed.responseText, failure: executed.failure });
    }

    const result = executed.result;
    if (result.resolverState === 'ambiguous' || result.resolverState === 'low_confidence') {
      upsertPending(state, buildPendingRecord({
        userId,
        chatId,
        now,
        entry: { requestSuffix: pending.mediaType, targetService: noun },
        originalQuery: canonicalQueryText(canonical),
        requestText,
        result,
        clarificationText: clarification
      }));
      const candidateSource = result.candidates || pending.candidates || [];
      const hasKnownYearWithoutOptions = canonical.year && !hasActionableNumberedCandidates(candidateSource);
      return finalize({
        auditOutcome: result.resolverState,
        responseText: hasKnownYearWithoutOptions
          ? knownYearStillUnclearPrompt(canonical, noun)
          : mapResultToTemplate(result, noun, {
              originalQuery: canonicalQueryText(canonical),
              canonical,
              candidates: candidateSource
            })
      });
    }

    clearPendingFor(state, userId, chatId);
    if (result.resolverState === 'no_result') {
      return finalize({
        auditOutcome: 'pending_unresolved',
        responseText: `I still couldn't resolve that media request. Please rerun /${pending.mediaType} ${canonicalQueryText(pending.canonical || canonicalFromQuery(pending.originalQuery, pending.mediaType))}.`
      });
    }
    return finalize({
      auditOutcome: result.addResult === 'success' ? 'success' : result.resolverState || 'handled',
      responseText: mapResultToTemplate(result, noun),
      failure: executed.failure
    });
  }

  if (entry?.kind === 'help') {
    return finalize({
      auditOutcome: 'mediahelp',
      responseText: buildTelegramMediaHelpText(registry)
    });
  }

  if (!entry || !entry.requestSuffix || !entry.targetService) {
    return {
      kind: 'unhandled',
      responseText: null
    };
  }

  if (!arg) {
    return finalize({
      auditOutcome: 'usage_error',
      responseText: `Usage: ${entry.usage}`
    });
  }

  const history = state.requestHistory.filter((item) => item.userId === userId);
  if (history.length >= RATE_LIMIT_MAX_REQUESTS) {
    return finalize({
      auditOutcome: 'rate_limited',
      responseText: 'Too many media requests right now. Try again in a few minutes.'
    });
  }

  const key = requestKey(userId, command, arg);
  const prior = state.recentRequests.find((item) => item.key === key);
  if (prior) {
    return finalize({
      auditOutcome: 'duplicate_blocked',
      responseText: 'That request was already sent recently. Wait a moment before trying again.'
    });
  }

  state.requestHistory.push({ userId, ts: now, command });
  state.recentRequests.push({ key, userId, ts: now, command, arg });

  const initialCanonical = canonicalFromQuery(arg, entry.requestSuffix);
  const requestText = canonicalQueryText(initialCanonical, true);
  const noun = entry.targetService;
  const executed = await executeMediaRequest({ runner, requestText, noun });
  if (!executed.ok) {
    clearPendingFor(state, userId, chatId);
    return finalize({ auditOutcome: 'backend_unavailable', responseText: executed.responseText, failure: executed.failure });
  }

  const result = executed.result;
  if (result.resolverState === 'ambiguous' || result.resolverState === 'low_confidence') {
    upsertPending(state, buildPendingRecord({
      userId,
      chatId,
      now,
      entry,
      originalQuery: arg,
      requestText,
      result
    }));
  } else {
    clearPendingFor(state, userId, chatId);
  }

  return finalize({
    auditOutcome: result.addResult === 'success' ? 'success' : result.resolverState || 'handled',
    responseText: mapResultToTemplate(result, noun, { originalQuery: arg, canonical: initialCanonical, candidates: result.candidates || [] }),
    failure: executed.failure
  });
}

function hasPendingTelegramMediaClarification(options = {}) {
  const userId = String(options.userId || '').trim() || 'unknown';
  const chatId = normalizeChatId(options.chatId);
  const now = Number(options.now || Date.now());
  const state = pruneState(readState(), now);
  writeState(state);
  return Boolean(activePendingFor(state, userId, chatId));
}

export { handleTelegramMediaCommand, hasPendingTelegramMediaClarification, mapResultToTemplate };
