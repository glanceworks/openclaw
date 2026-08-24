import assert from "node:assert/strict";
import test from "node:test";
import { ArrApiError, ArrClient, parseTitleQuery } from "./arr-client.js";
import type { ViktorMediaConfig } from "./config.js";

const config: ViktorMediaConfig = {
  radarr: {
    baseUrl: "https://radarr.invalid/",
    apiKey: "radarr-key",
    qualityProfileId: 7,
    rootFolderPath: "/movies",
    monitoring: true,
  },
  sonarr: {
    baseUrl: "https://sonarr.invalid/",
    apiKey: "sonarr-key",
    qualityProfileId: 7,
    rootFolderPath: "/shows",
    monitorNewItems: "all",
  },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestTarget(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new TypeError("Expected a JSON request body.");
  }
  return body;
}

function movie(overrides: Record<string, unknown> = {}) {
  return {
    title: "Arrival",
    year: 2016,
    titleSlug: "arrival-2016",
    tmdbId: 329865,
    imdbId: "tt2543164",
    images: [],
    monitored: true,
    ...overrides,
  };
}

function show(overrides: Record<string, unknown> = {}) {
  return {
    title: "Severance",
    year: 2022,
    titleSlug: "severance",
    tvdbId: 371980,
    imdbId: "tt11280740",
    images: [],
    seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
    monitored: true,
    ...overrides,
  };
}

void test("parses only a trailing year that follows a non-empty title", () => {
  assert.deepEqual(parseTitleQuery("Arrival (2016)"), { title: "Arrival", year: 2016 });
  assert.deepEqual(parseTitleQuery("Arrival 2016"), { title: "Arrival", year: 2016 });
  assert.deepEqual(parseTitleQuery("1917"), { title: "1917", year: null });
});

void test("adds one exact Radarr match with existing policy and triggers search", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new ArrClient(config, async (input, init) => {
    const url = new URL(requestTarget(input));
    calls.push({ url, init });
    if (url.pathname.endsWith("/movie/lookup")) {
      return jsonResponse([movie()]);
    }
    if (url.pathname.endsWith("/movie") && init?.method !== "POST") {
      return jsonResponse([]);
    }
    if (url.pathname.endsWith("/movie")) {
      return jsonResponse({ ...movie(), id: 42 }, 201);
    }
    if (url.pathname.endsWith("/command")) {
      return jsonResponse({ id: 99 }, 201);
    }
    return jsonResponse({}, 404);
  });

  assert.deepEqual(await client.request("movie", "Arrival 2016"), {
    status: "added",
    title: "Arrival (2016)",
    searchAccepted: true,
  });
  const addBody = JSON.parse(
    requestBody(
      calls.find((call) => call.url.pathname.endsWith("/movie") && call.init?.method === "POST")
        ?.init?.body,
    ),
  );
  assert.equal(addBody.qualityProfileId, 7);
  assert.equal(addBody.rootFolderPath, "/movies");
  assert.equal(addBody.monitored, true);
  assert.deepEqual(addBody.addOptions, { searchForMovie: false });
  const searchBody = JSON.parse(
    requestBody(calls.find((call) => call.url.pathname.endsWith("/command"))?.init?.body),
  );
  assert.deepEqual(searchBody, { name: "MoviesSearch", movieIds: [42] });
});

void test("adds one exact Sonarr match and triggers the configured series search", async () => {
  const bodies: unknown[] = [];
  const client = new ArrClient(config, async (input, init) => {
    const url = new URL(requestTarget(input));
    if (url.pathname.endsWith("/series/lookup")) {
      return jsonResponse([show()]);
    }
    if (url.pathname.endsWith("/series") && init?.method !== "POST") {
      return jsonResponse([]);
    }
    if (url.pathname.endsWith("/series")) {
      bodies.push(JSON.parse(requestBody(init?.body)));
      return jsonResponse({ ...show(), id: 24 }, 201);
    }
    if (url.pathname.endsWith("/command")) {
      bodies.push(JSON.parse(requestBody(init?.body)));
      return jsonResponse({ id: 100 }, 201);
    }
    return jsonResponse({}, 404);
  });

  assert.deepEqual(await client.request("show", "Severance (2022)"), {
    status: "added",
    title: "Severance (2022)",
    searchAccepted: true,
  });
  assert.deepEqual(bodies[0], {
    title: "Severance",
    qualityProfileId: 7,
    titleSlug: "severance",
    images: [],
    tvdbId: 371980,
    year: 2022,
    rootFolderPath: "/shows",
    monitored: true,
    monitorNewItems: "all",
    seasons: [
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: true },
    ],
    addOptions: { searchForMissingEpisodes: false },
  });
  assert.deepEqual(bodies[1], { name: "SeriesSearch", seriesId: 24 });
});

void test("returns no result without reading the library or writing", async () => {
  let calls = 0;
  const client = new ArrClient(config, async () => {
    calls += 1;
    return jsonResponse([]);
  });

  assert.deepEqual(await client.request("movie", "Missing"), { status: "no-result" });
  assert.equal(calls, 1);
});

void test("returns at most three choices instead of adding a low-confidence result", async () => {
  let calls = 0;
  const client = new ArrClient(config, async () => {
    calls += 1;
    return jsonResponse([
      movie({ title: "Saved!", year: 2004, tmdbId: 1 }),
      movie({ title: "Saved", year: 2009, tmdbId: 2 }),
      movie({ title: "Saved", year: 2012, tmdbId: 3 }),
      movie({ title: "Saved", year: 2001, tmdbId: 4 }),
    ]);
  });

  const result = await client.request("movie", "Saved");
  assert.equal(result.status, "choices");
  if (result.status === "choices") {
    assert.equal(result.choices.length, 3);
  }
  assert.equal(calls, 1);
});

void test("uses backend identity to report existing and unmonitored media without retriggering", async () => {
  let posts = 0;
  const client = new ArrClient(config, async (input, init) => {
    const url = new URL(requestTarget(input));
    if (init?.method === "POST") {
      posts += 1;
    }
    if (url.pathname.endsWith("/movie/lookup")) {
      return jsonResponse([movie()]);
    }
    return jsonResponse([movie({ title: "Arrival (Director's Cut)", monitored: false })]);
  });

  assert.deepEqual(await client.request("movie", "Arrival 2016"), {
    status: "already-managed",
    title: "Arrival (Director's Cut) (2016)",
    unmonitored: true,
  });
  assert.equal(posts, 0);
});

for (const kind of ["movie", "show"] as const) {
  void test(`${kind} add rejection is classified without triggering search`, async () => {
    let commandCalls = 0;
    const client = new ArrClient(config, async (input, init) => {
      const url = new URL(requestTarget(input));
      if (url.pathname.endsWith(kind === "movie" ? "/movie/lookup" : "/series/lookup")) {
        return jsonResponse([kind === "movie" ? movie() : show()]);
      }
      if (
        url.pathname.endsWith(kind === "movie" ? "/movie" : "/series") &&
        init?.method !== "POST"
      ) {
        return jsonResponse([]);
      }
      if (url.pathname.endsWith("/command")) {
        commandCalls += 1;
      }
      return jsonResponse({ error: "rejected" }, 400);
    });

    await assert.rejects(
      client.request(kind, kind === "movie" ? "Arrival 2016" : "Severance 2022"),
      (error) => error instanceof ArrApiError && error.kind === "rejected",
    );
    assert.equal(commandCalls, 0);
  });
}

void test("reports an accepted add separately when the search trigger fails", async () => {
  const client = new ArrClient(config, async (input, init) => {
    const url = new URL(requestTarget(input));
    if (url.pathname.endsWith("/movie/lookup")) {
      return jsonResponse([movie()]);
    }
    if (url.pathname.endsWith("/movie") && init?.method !== "POST") {
      return jsonResponse([]);
    }
    if (url.pathname.endsWith("/movie")) {
      return jsonResponse({ ...movie(), id: 42 }, 201);
    }
    return jsonResponse({ error: "unavailable" }, 503);
  });

  assert.deepEqual(await client.request("movie", "Arrival 2016"), {
    status: "added",
    title: "Arrival (2016)",
    searchAccepted: false,
  });
});

void test("a repeated request relies on the durable Radarr library instead of plugin state", async () => {
  let managed = false;
  let addCalls = 0;
  const client = new ArrClient(config, async (input, init) => {
    const url = new URL(requestTarget(input));
    if (url.pathname.endsWith("/movie/lookup")) {
      return jsonResponse([movie()]);
    }
    if (url.pathname.endsWith("/movie") && init?.method !== "POST") {
      return jsonResponse(managed ? [movie({ id: 42 })] : []);
    }
    if (url.pathname.endsWith("/movie")) {
      addCalls += 1;
      managed = true;
      return jsonResponse({ ...movie(), id: 42 }, 201);
    }
    return jsonResponse({ id: 99 }, 201);
  });

  assert.equal((await client.request("movie", "Arrival 2016")).status, "added");
  assert.equal((await client.request("movie", "Arrival 2016")).status, "already-managed");
  assert.equal(addCalls, 1);
});
