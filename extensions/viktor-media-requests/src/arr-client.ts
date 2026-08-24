import type { ViktorMediaConfig } from "./config.js";

export type MediaKind = "movie" | "show";
type JsonObject = Record<string, unknown>;

export type MediaCandidate = {
  item: JsonObject;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
};

export type RequestResult =
  | { status: "added"; title: string; searchAccepted: boolean }
  | { status: "already-managed"; title: string; unmonitored: boolean }
  | { status: "no-result" }
  | { status: "choices"; choices: Array<{ title: string; year: number | null }> };

export type ArrFailureKind = "authentication" | "backend-unavailable" | "rejected";

export class ArrApiError extends Error {
  constructor(
    readonly service: "Radarr" | "Sonarr",
    readonly kind: ArrFailureKind,
    readonly status: number | null,
  ) {
    super(`${service} request failed (${kind}).`);
  }
}

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function parseTitleQuery(raw: string): { title: string; year: number | null } {
  const input = raw.trim().replace(/\s+/gu, " ");
  const match = /^(.*?)\s*(?:\((19\d{2}|20\d{2}|21\d{2})\)|(19\d{2}|20\d{2}|21\d{2}))$/u.exec(
    input,
  );
  if (!match) {
    return { title: input, year: null };
  }
  const title = match[1]?.trim();
  if (!title) {
    return { title: input, year: null };
  }
  return { title, year: Number(match[2] ?? match[3]) };
}

function candidateFrom(value: unknown, kind: MediaKind): MediaCandidate | null {
  const item = objectValue(value);
  if (!item) {
    return null;
  }
  const title = stringValue(item.title) ?? stringValue(item.name);
  if (!title) {
    return null;
  }
  const firstAired = stringValue(item.firstAired);
  const tmdbId = numberValue(item.tmdbId);
  const tvdbId = kind === "show" ? numberValue(item.tvdbId) : null;
  if (kind === "movie" ? tmdbId === null : tvdbId === null) {
    return null;
  }
  return {
    item,
    title,
    year: numberValue(item.year) ?? (firstAired ? numberValue(firstAired.slice(0, 4)) : null),
    tmdbId,
    tvdbId,
    imdbId: stringValue(item.imdbId),
  };
}

function exactMatches(
  candidates: MediaCandidate[],
  query: { title: string; year: number | null },
): MediaCandidate[] {
  const normalizedQuery = normalizeTitle(query.title);
  return candidates.filter(
    (candidate) =>
      normalizeTitle(candidate.title) === normalizedQuery &&
      (query.year === null || candidate.year === query.year),
  );
}

function candidateIdentityMatches(left: MediaCandidate, right: MediaCandidate): boolean {
  if (left.tmdbId && right.tmdbId && left.tmdbId === right.tmdbId) {
    return true;
  }
  if (left.tvdbId && right.tvdbId && left.tvdbId === right.tvdbId) {
    return true;
  }
  if (left.imdbId && right.imdbId && left.imdbId === right.imdbId) {
    return true;
  }
  return (
    left.year !== null &&
    right.year !== null &&
    left.year === right.year &&
    normalizeTitle(left.title) === normalizeTitle(right.title)
  );
}

function classifyFailure(status: number | null): ArrFailureKind {
  if (status === 401 || status === 403) {
    return "authentication";
  }
  if (status === null || status === 408 || status === 429 || status >= 500) {
    return "backend-unavailable";
  }
  return "rejected";
}

function displayTitle(candidate: MediaCandidate): string {
  return `${candidate.title}${candidate.year ? ` (${candidate.year})` : ""}`;
}

export class ArrClient {
  constructor(
    private readonly config: ViktorMediaConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request(kind: MediaKind, rawTitle: string): Promise<RequestResult> {
    const query = parseTitleQuery(rawTitle);
    const lookup = await this.lookup(kind, query.title);
    if (lookup.length === 0) {
      return { status: "no-result" };
    }

    const exact = exactMatches(lookup, query);
    if (exact.length !== 1) {
      const choices = (exact.length > 1 ? exact : lookup).slice(0, 3).map((candidate) => ({
        title: candidate.title,
        year: candidate.year,
      }));
      return { status: "choices", choices };
    }

    const candidate = exact[0];
    const existing = (await this.library(kind)).find((entry) =>
      candidateIdentityMatches(candidate, entry),
    );
    if (existing) {
      return {
        status: "already-managed",
        title: displayTitle(existing),
        unmonitored: existing.item.monitored === false,
      };
    }

    const added = await this.add(kind, candidate);
    const searchAccepted = await this.triggerSearch(kind, added.id);
    return { status: "added", title: added.title, searchAccepted };
  }

  private service(kind: MediaKind) {
    return kind === "movie"
      ? { name: "Radarr" as const, config: this.config.radarr }
      : { name: "Sonarr" as const, config: this.config.sonarr };
  }

  private url(kind: MediaKind, path: string): URL {
    return new URL(path.replace(/^\/+/u, ""), this.service(kind).config.baseUrl);
  }

  private async requestJson(
    kind: MediaKind,
    path: string,
    options: { method?: "GET" | "POST"; body?: JsonObject } = {},
  ): Promise<unknown> {
    const service = this.service(kind);
    let response: Response;
    try {
      response = await this.fetchFn(this.url(kind, path), {
        method: options.method ?? "GET",
        headers: {
          "X-Api-Key": service.config.apiKey,
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ArrApiError(service.name, "backend-unavailable", null);
    }
    if (!response.ok) {
      throw new ArrApiError(service.name, classifyFailure(response.status), response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new ArrApiError(service.name, "backend-unavailable", response.status);
    }
  }

  private async lookup(kind: MediaKind, term: string): Promise<MediaCandidate[]> {
    const path =
      kind === "movie"
        ? `api/v3/movie/lookup?term=${encodeURIComponent(term)}`
        : `api/v3/series/lookup?term=${encodeURIComponent(term)}`;
    const response = await this.requestJson(kind, path);
    return (Array.isArray(response) ? response : [])
      .map((item) => candidateFrom(item, kind))
      .filter((item): item is MediaCandidate => item !== null);
  }

  private async library(kind: MediaKind): Promise<MediaCandidate[]> {
    const response = await this.requestJson(
      kind,
      kind === "movie" ? "api/v3/movie" : "api/v3/series",
    );
    return (Array.isArray(response) ? response : [])
      .map((item) => candidateFrom(item, kind))
      .filter((item): item is MediaCandidate => item !== null);
  }

  private async add(
    kind: MediaKind,
    candidate: MediaCandidate,
  ): Promise<{ id: number; title: string }> {
    const service = this.service(kind).config;
    const body: JsonObject =
      kind === "movie"
        ? {
            title: candidate.title,
            qualityProfileId: service.qualityProfileId,
            titleSlug: candidate.item.titleSlug,
            images: Array.isArray(candidate.item.images) ? candidate.item.images : [],
            tmdbId: candidate.tmdbId,
            year: candidate.year,
            rootFolderPath: service.rootFolderPath,
            monitored: this.config.radarr.monitoring,
            addOptions: { searchForMovie: false },
          }
        : {
            title: candidate.title,
            qualityProfileId: service.qualityProfileId,
            titleSlug: candidate.item.titleSlug,
            images: Array.isArray(candidate.item.images) ? candidate.item.images : [],
            tvdbId: candidate.tvdbId,
            year: candidate.year,
            rootFolderPath: service.rootFolderPath,
            monitored: true,
            monitorNewItems: this.config.sonarr.monitorNewItems,
            seasons: (Array.isArray(candidate.item.seasons) ? candidate.item.seasons : []).map(
              (season) => ({
                seasonNumber: objectValue(season)?.seasonNumber,
                monitored: true,
              }),
            ),
            addOptions: { searchForMissingEpisodes: false },
          };
    const response = objectValue(
      await this.requestJson(kind, kind === "movie" ? "api/v3/movie" : "api/v3/series", {
        method: "POST",
        body,
      }),
    );
    const id = numberValue(response?.id);
    if (!response || id === null) {
      throw new ArrApiError(this.service(kind).name, "rejected", null);
    }
    const addedCandidate = candidateFrom(response, kind) ?? candidate;
    return { id, title: displayTitle(addedCandidate) };
  }

  private async triggerSearch(kind: MediaKind, id: number): Promise<boolean> {
    const body =
      kind === "movie"
        ? { name: "MoviesSearch", movieIds: [id] }
        : { name: "SeriesSearch", seriesId: id };
    try {
      await this.requestJson(kind, "api/v3/command", { method: "POST", body });
      return true;
    } catch {
      return false;
    }
  }
}
