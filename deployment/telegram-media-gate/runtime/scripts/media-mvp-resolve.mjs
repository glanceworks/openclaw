import fs from 'fs';
import { getMediaRequestMvpConfigPath } from './telegram-media-paths.mjs';

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getConfiguredValue(serviceCfg, envName, key) {
  const envValue = process.env[envName]?.trim();
  if (envValue) return envValue;
  const cfgValue = serviceCfg?.[key];
  if (typeof cfgValue === 'string' && cfgValue.trim()) return cfgValue.trim();
  return '';
}

function normalizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseRequest(input) {
  const raw = String(input || '').trim();
  const lower = raw.toLowerCase();
  const yearMatch = raw.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const explicitMovie = /\b(movie|film)\b/i.test(raw);
  const explicitSeries = /\b(show|series|tv)\b/i.test(raw);
  const seasonHint = /\bseason\s+\d+\b/i.test(raw);
  let typeHint = null;
  if (explicitMovie && !explicitSeries) typeHint = 'movie';
  else if (explicitSeries && !explicitMovie) typeHint = 'series';
  else if (seasonHint) typeHint = 'series';

  let title = raw
    .replace(/^(add|get|download|download the|add the|get the)\s+/i, '')
    .replace(/\b(movie|film|show|series|tv)\b/gi, ' ')
    .replace(/\bseason\s+\d+\b/gi, ' ')
    .replace(/\b(19\d{2}|20\d{2}|21\d{2})\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title) title = raw;
  return { raw, title, year, typeHint, explicitMovie, explicitSeries, seasonHint, normalizedTitle: normalizeTitle(title), lower };
}


function classifyFetchException(err) {
  const message = String(err?.message || err || '');
  const causeMessage = String(err?.cause?.message || '');
  const code = String(err?.cause?.code || err?.code || '');
  const haystack = `${code} ${message} ${causeMessage}`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(haystack)) return 'DNS';
  if (/ECONNREFUSED/i.test(haystack)) return 'connection_refused';
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timeout|aborted/i.test(haystack)) return 'timeout';
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(haystack)) return 'TLS';
  return 'other';
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return 'HTTP 401/403';
  if (status === 404) return 'HTTP 404';
  if (status >= 500) return 'HTTP 5xx';
  if (status >= 400) return `HTTP ${status}`;
  return 'ok';
}

function safeFailureMeta(kind, fetchResult) {
  return {
    phase: kind,
    category: fetchResult.failureCategory || classifyHttpStatus(Number(fetchResult.status || 0)),
    status: Number.isFinite(Number(fetchResult.status)) ? Number(fetchResult.status) : null,
    errorClass: fetchResult.errorClass || null
  };
}

async function fetchJson(url, apiKey) {
  try {
    const res = await fetch(url, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    let jsonOk = true;
    try { data = text ? JSON.parse(text) : null; } catch { jsonOk = false; }
    const failureCategory = !jsonOk ? 'invalid_JSON' : classifyHttpStatus(res.status);
    return { status: res.status, ok: res.ok && jsonOk, data, text: '', failureCategory };
  } catch (err) {
    return {
      status: null,
      ok: false,
      data: null,
      text: '',
      failureCategory: classifyFetchException(err),
      errorClass: err?.name || err?.constructor?.name || 'Error'
    };
  }
}

function serviceConfig(cfg, name) {
  const svc = cfg[name] || {};
  return {
    baseUrl: getConfiguredValue(svc, `${name.toUpperCase()}_BASE_URL`, 'baseUrl').replace(/\/+$/, ''),
    apiKey: getConfiguredValue(svc, `${name.toUpperCase()}_API_KEY`, 'apiKey')
  };
}

async function lookupMovies(radarr, term) {
  return fetchJson(`${radarr.baseUrl}/api/v3/movie/lookup?term=${encodeURIComponent(term)}`, radarr.apiKey);
}
async function lookupSeries(sonarr, term) {
  return fetchJson(`${sonarr.baseUrl}/api/v3/series/lookup?term=${encodeURIComponent(term)}`, sonarr.apiKey);
}
async function libraryMovies(radarr) {
  return fetchJson(`${radarr.baseUrl}/api/v3/movie`, radarr.apiKey);
}
async function librarySeries(sonarr) {
  return fetchJson(`${sonarr.baseUrl}/api/v3/series`, sonarr.apiKey);
}

function scoreCandidate(candidate, parsed, type) {
  const title = candidate.title || candidate.name || '';
  const norm = normalizeTitle(title);
  let score = 0;
  if (norm === parsed.normalizedTitle) score += 100;
  else if (norm.includes(parsed.normalizedTitle) || parsed.normalizedTitle.includes(norm)) score += 70;
  else {
    const pWords = new Set(parsed.normalizedTitle.split(' ').filter(Boolean));
    const cWords = new Set(norm.split(' ').filter(Boolean));
    let overlap = 0;
    for (const w of pWords) if (cWords.has(w)) overlap += 1;
    score += overlap * 10;
  }
  const year = type === 'movie' ? candidate.year : candidate.year || (candidate.firstAired ? Number(String(candidate.firstAired).slice(0,4)) : null);
  if (parsed.year && year) {
    if (Number(year) === parsed.year) score += 40;
    else score -= 25;
  }
  if (parsed.typeHint === type) score += 5;
  return { score, year: year || null, title };
}

function strongCandidates(cands) {
  if (cands.length === 0) return [];
  const top = cands[0].score;
  return cands.filter(c => c.score >= top - 10 && c.score >= 80);
}

function chooseCandidates(data, parsed, type) {
  const items = Array.isArray(data) ? data : [];
  const scored = items.map(item => ({ item, ...scoreCandidate(item, parsed, type) }))
    .sort((a,b) => b.score - a.score || String(a.title).localeCompare(String(b.title)));
  return scored;
}

function extractIds(item, type) {
  return {
    tmdbId: item.tmdbId ?? null,
    tvdbId: type === 'series' ? (item.tvdbId ?? null) : null,
    imdbId: item.imdbId ?? null
  };
}

function findExistingByIds(existing, candidateIds, type) {
  if (!candidateIds) return null;
  return existing.find(entry => {
    if (candidateIds.tmdbId && entry.tmdbId && Number(entry.tmdbId) === Number(candidateIds.tmdbId)) return true;
    if (type === 'series' && candidateIds.tvdbId && entry.tvdbId && Number(entry.tvdbId) === Number(candidateIds.tvdbId)) return true;
    if (candidateIds.imdbId && entry.imdbId && String(entry.imdbId) === String(candidateIds.imdbId)) return true;
    return false;
  }) || null;
}

function findExistingByTitleYear(existing, candidate, type) {
  const candidateTitle = normalizeTitle(candidate.title || candidate.name || '');
  const candidateYear = type === 'movie' ? candidate.year : candidate.year || (candidate.firstAired ? Number(String(candidate.firstAired).slice(0,4)) : null);
  if (!candidateTitle || !candidateYear) return null;
  return existing.find(entry => {
    const entryTitle = normalizeTitle(entry.title || entry.name || '');
    const entryYear = type === 'movie' ? entry.year : entry.year || (entry.firstAired ? Number(String(entry.firstAired).slice(0,4)) : null);
    return entryTitle === candidateTitle && Number(entryYear) === Number(candidateYear);
  }) || null;
}

function nuanceForExisting(entry) {
  if (entry && entry.monitored === false) return 'present but not actively monitored';
  return null;
}

async function resolveForType(type, parsed, svcCfg) {
  const lookup = type === 'movie' ? await lookupMovies(svcCfg, parsed.title) : await lookupSeries(svcCfg, parsed.title);
  if (!lookup.ok || !Array.isArray(lookup.data)) {
    return { type, state: 'lookup_error', reason: `lookup failed (${lookup.status ?? 'no_status'})`, failure: safeFailureMeta('lookup', lookup) };
  }
  const candidates = chooseCandidates(lookup.data, parsed, type);
  if (candidates.length === 0) return { type, state: 'no_result' };
  const strong = strongCandidates(candidates);
  if (strong.length > 1) {
    return { type, state: 'ambiguous', candidates: strong.slice(0, 3) };
  }
  const best = candidates[0];
  if (best.score < 80) {
    return { type, state: 'low_confidence', candidate: best };
  }

  const library = type === 'movie' ? await libraryMovies(svcCfg) : await librarySeries(svcCfg);
  if (!library.ok || !Array.isArray(library.data)) {
    return { type, state: 'library_error', reason: `library failed (${library.status ?? 'no_status'})`, failure: safeFailureMeta('library', library), candidate: best };
  }
  const ids = extractIds(best.item, type);
  const existing = findExistingByIds(library.data, ids, type) || findExistingByTitleYear(library.data, best.item, type);
  if (existing) {
    const nuance = nuanceForExisting(existing);
    return { type, state: nuance ? 'already_exists_with_nuance' : 'already_exists', candidate: best, nuance };
  }
  return { type, state: 'resolved', candidate: best };
}

async function resolveRequest(input) {
  const cfg = readJson(getMediaRequestMvpConfigPath());
  const sonarr = serviceConfig(cfg, 'sonarr');
  const radarr = serviceConfig(cfg, 'radarr');
  const parsed = parseRequest(input);

  let preferredType = parsed.typeHint;
  if (!preferredType && parsed.explicitMovie) preferredType = 'movie';
  if (!preferredType && (parsed.explicitSeries || parsed.seasonHint)) preferredType = 'series';

  if (preferredType === 'movie') {
    const result = await resolveForType('movie', parsed, radarr);
    return { input, parsed, classification: 'movie', targetService: 'radarr', ...result };
  }
  if (preferredType === 'series') {
    const result = await resolveForType('series', parsed, sonarr);
    return { input, parsed, classification: 'series', targetService: 'sonarr', ...result };
  }

  const [movieRes, seriesRes] = await Promise.all([
    resolveForType('movie', parsed, radarr),
    resolveForType('series', parsed, sonarr)
  ]);

  const movieStrong = movieRes.state === 'resolved' || movieRes.state === 'already_exists' || movieRes.state === 'already_exists_with_nuance';
  const seriesStrong = seriesRes.state === 'resolved' || seriesRes.state === 'already_exists' || seriesRes.state === 'already_exists_with_nuance';

  if (movieStrong && !seriesStrong) return { input, parsed, classification: 'movie', targetService: 'radarr', ...movieRes };
  if (seriesStrong && !movieStrong) return { input, parsed, classification: 'series', targetService: 'sonarr', ...seriesRes };
  if (movieStrong && seriesStrong) {
    return {
      input,
      parsed,
      classification: 'unclear',
      targetService: 'ambiguous',
      state: 'ambiguous',
      candidates: [movieRes.candidate, seriesRes.candidate].filter(Boolean)
    };
  }

  if (movieRes.state === 'ambiguous' || seriesRes.state === 'ambiguous') {
    return {
      input,
      parsed,
      classification: 'unclear',
      targetService: 'ambiguous',
      state: 'ambiguous',
      candidates: [...(movieRes.candidates || []), ...(seriesRes.candidates || [])].slice(0, 4)
    };
  }

  return {
    input,
    parsed,
    classification: 'unclear',
    targetService: 'none',
    state: 'low_confidence',
    candidates: [movieRes.candidate, seriesRes.candidate].filter(Boolean)
  };
}

function summarize(result) {
  const matchedTitle = result.candidate ? `${result.candidate.title}${result.candidate.year ? ` (${result.candidate.year})` : ''}` : null;
  return {
    input: result.input,
    classification: result.classification,
    targetService: result.targetService,
    resolutionState: result.state,
    clarificationRequired: result.state === 'ambiguous' || result.state === 'low_confidence',
    matchedTitle,
    nuance: result.nuance || null,
    failure: result.failure || null
  };
}

async function main() {
  const raw = process.argv.slice(2).join(' ').trim();
  if (!raw) die('Usage: node scripts/media-mvp-resolve.mjs "request text"', 2);
  const result = await resolveRequest(raw);
  console.log(JSON.stringify({ result, summary: summarize(result) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { parseRequest, resolveRequest, summarize };
