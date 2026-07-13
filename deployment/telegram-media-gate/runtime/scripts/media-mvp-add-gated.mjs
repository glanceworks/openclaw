import fs from 'fs';
import { resolveRequest } from './media-mvp-resolve.mjs';
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

function getConfiguredNumber(serviceCfg, envName, key) {
  const envValue = process.env[envName]?.trim();
  if (envValue) return Number(envValue);
  const cfgValue = serviceCfg?.[key];
  if (cfgValue !== null && cfgValue !== undefined && cfgValue !== '') return Number(cfgValue);
  return NaN;
}

function serviceConfig(cfg, name) {
  const svc = cfg[name] || {};
  return {
    baseUrl: getConfiguredValue(svc, `${name.toUpperCase()}_BASE_URL`, 'baseUrl').replace(/\/+$/, ''),
    apiKey: getConfiguredValue(svc, `${name.toUpperCase()}_API_KEY`, 'apiKey'),
    qualityProfileId: getConfiguredNumber(svc, `${name.toUpperCase()}_QUALITY_PROFILE_ID`, 'qualityProfileId'),
    rootFolderPath: getConfiguredValue(svc, `${name.toUpperCase()}_ROOT_FOLDER_PATH`, 'rootFolderPath'),
    monitoring: svc.monitoring
  };
}

async function fetchJson(url, apiKey, options = {}) {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, data, text };
}

function candidateYear(candidate, type) {
  return type === 'movie'
    ? candidate.item?.year ?? candidate.year ?? null
    : candidate.item?.year ?? candidate.year ?? (candidate.item?.firstAired ? Number(String(candidate.item.firstAired).slice(0, 4)) : null);
}

function summarizeCandidate(candidate, fallbackType = null) {
  if (!candidate) return null;
  const inferredType = fallbackType || (candidate.item?.tvdbId ? 'series' : 'movie');
  return {
    title: candidate.title || candidate.item?.title || candidate.item?.name || null,
    year: candidateYear(candidate, inferredType === 'series' ? 'series' : 'movie'),
    type: inferredType
  };
}

function summarizeCandidates(candidates, fallbackType = null) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => summarizeCandidate(candidate, fallbackType))
    .filter(Boolean);
}

function finalResponse(result) {
  const title = result.matchedTitle || result.resolvedTitle || 'title';
  if (result.resolverState === 'already_exists') return `${title} is already in ${result.targetService === 'radarr' ? 'Radarr' : 'Sonarr'}.`;
  if (result.resolverState === 'already_exists_with_nuance') return `${title} is already in ${result.targetService === 'radarr' ? 'Radarr' : 'Sonarr'}${result.nuance ? `, but ${result.nuance}.` : '.'}`;
  if (result.resolverState === 'ambiguous') return 'I found multiple likely matches. Give me the year or tell me whether you want the movie or the show.';
  if (result.resolverState === 'low_confidence') return 'I’m not confident enough to proceed safely. Give me the year or specify movie vs show.';
  if (result.resolverState === 'no_result') return 'I couldn’t find a confident match for that title.';
  if (result.addResult === 'failed') return `I found the right title, but ${result.targetService === 'radarr' ? 'Radarr' : 'Sonarr'} rejected the add.`;
  if (result.addResult === 'success' && result.searchTriggerResult === 'failed') return `Added ${title} to ${result.targetService === 'radarr' ? 'Radarr' : 'Sonarr'}, but I couldn’t start the search.`;
  if (result.addResult === 'success' && result.searchTriggerResult === 'success') return `Added ${title} to ${result.targetService === 'radarr' ? 'Radarr' : 'Sonarr'} and triggered search.`;
  return 'No action taken.';
}

async function addRadarr(radarr, candidate) {
  const body = {
    title: candidate.item.title,
    qualityProfileId: radarr.qualityProfileId,
    titleSlug: candidate.item.titleSlug,
    images: candidate.item.images || [],
    tmdbId: candidate.item.tmdbId,
    year: candidate.item.year,
    rootFolderPath: radarr.rootFolderPath,
    monitored: radarr.monitoring === true,
    addOptions: { searchForMovie: false }
  };
  return fetchJson(`${radarr.baseUrl}/api/v3/movie`, radarr.apiKey, { method: 'POST', body });
}

async function addSonarr(sonarr, candidate) {
  const body = {
    title: candidate.item.title,
    qualityProfileId: sonarr.qualityProfileId,
    titleSlug: candidate.item.titleSlug,
    images: candidate.item.images || [],
    tvdbId: candidate.item.tvdbId,
    year: candidateYear(candidate, 'series'),
    rootFolderPath: sonarr.rootFolderPath,
    monitored: true,
    monitorNewItems: sonarr.monitoring || 'all',
    seasons: (candidate.item.seasons || []).map(s => ({ seasonNumber: s.seasonNumber, monitored: true })),
    addOptions: { searchForMissingEpisodes: false }
  };
  return fetchJson(`${sonarr.baseUrl}/api/v3/series`, sonarr.apiKey, { method: 'POST', body });
}

async function triggerRadarrSearch(radarr, movieId) {
  return fetchJson(`${radarr.baseUrl}/api/v3/command`, radarr.apiKey, { method: 'POST', body: { name: 'MoviesSearch', movieIds: [movieId] } });
}

async function triggerSonarrSearch(sonarr, seriesId) {
  return fetchJson(`${sonarr.baseUrl}/api/v3/command`, sonarr.apiKey, { method: 'POST', body: { name: 'SeriesSearch', seriesId } });
}

async function runOne(input) {
  const cfg = readJson(getMediaRequestMvpConfigPath());
  const sonarr = serviceConfig(cfg, 'sonarr');
  const radarr = serviceConfig(cfg, 'radarr');
  const resolved = await resolveRequest(input);
  const summary = resolved.candidate ? `${resolved.candidate.title}${resolved.candidate.year ? ` (${resolved.candidate.year})` : ''}` : null;
  const out = {
    input,
    resolverState: resolved.state,
    targetService: resolved.targetService,
    writeAllowed: false,
    addResult: 'not_attempted',
    searchTriggerResult: 'not_attempted',
    matchedTitle: summary,
    nuance: resolved.nuance || null,
    candidates: summarizeCandidates(resolved.candidates, resolved.type || (resolved.targetService === 'sonarr' ? 'series' : resolved.targetService === 'radarr' ? 'movie' : null)),
    finalUserFacingResponse: ''
  };

  if (resolved.state === 'already_exists' || resolved.state === 'already_exists_with_nuance' || resolved.state === 'ambiguous' || resolved.state === 'low_confidence' || resolved.state === 'no_result') {
    out.finalUserFacingResponse = finalResponse(out);
    return out;
  }

  if (resolved.state !== 'resolved' || !resolved.candidate) {
    out.finalUserFacingResponse = 'No action taken.';
    return out;
  }

  out.writeAllowed = true;

  if (resolved.targetService === 'radarr') {
    const add = await addRadarr(radarr, resolved.candidate);
    if (!add.ok || !add.data?.id) {
      out.addResult = 'failed';
      out.finalUserFacingResponse = finalResponse(out);
      return out;
    }
    out.addResult = 'success';
    const confirmedId = add.data.id;
    const confirmedTitle = `${add.data.title}${add.data.year ? ` (${add.data.year})` : ''}`;
    out.matchedTitle = confirmedTitle;
    const search = await triggerRadarrSearch(radarr, confirmedId);
    out.searchTriggerResult = search.ok ? 'success' : 'failed';
    out.finalUserFacingResponse = finalResponse(out);
    return out;
  }

  if (resolved.targetService === 'sonarr') {
    const add = await addSonarr(sonarr, resolved.candidate);
    if (!add.ok || !add.data?.id) {
      out.addResult = 'failed';
      out.finalUserFacingResponse = finalResponse(out);
      return out;
    }
    out.addResult = 'success';
    const confirmedId = add.data.id;
    const confirmedTitle = `${add.data.title}${add.data.year ? ` (${add.data.year})` : ''}`;
    out.matchedTitle = confirmedTitle;
    const search = await triggerSonarrSearch(sonarr, confirmedId);
    out.searchTriggerResult = search.ok ? 'success' : 'failed';
    out.finalUserFacingResponse = finalResponse(out);
    return out;
  }

  out.finalUserFacingResponse = 'No action taken.';
  return out;
}

async function main() {
  if (process.env.MEDIA_MVP_ENABLE_WRITES !== 'true') {
    die('Write path is gated. Set MEDIA_MVP_ENABLE_WRITES=true for controlled/manual testing only.', 2);
  }
  const raw = process.argv.slice(2).join(' ').trim();
  if (!raw) die('Usage: MEDIA_MVP_ENABLE_WRITES=true node scripts/media-mvp-add-gated.mjs "request text"', 2);
  const result = await runOne(raw);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { runOne };
