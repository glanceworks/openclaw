import assert from "node:assert/strict";
import test from "node:test";
import { readPluginConfig } from "./config.js";

function pluginConfig(overrides: Record<string, unknown> = {}) {
  return {
    tailnetOnlyHttp: false,
    radarr: {
      baseUrl: "https://radarr.invalid/radarr/",
      apiKey: "radarr-key",
      qualityProfileId: 7,
      rootFolderPath: "/movies",
      monitoring: true,
    },
    sonarr: {
      baseUrl: "https://sonarr.invalid/sonarr/",
      apiKey: "sonarr-key",
      qualityProfileId: 8,
      rootFolderPath: "/shows",
      monitorNewItems: "all",
    },
    ...overrides,
  };
}

void test("reads the existing Radarr and Sonarr policy without adding state", () => {
  assert.deepEqual(readPluginConfig(pluginConfig()), {
    radarr: {
      baseUrl: "https://radarr.invalid/radarr/",
      apiKey: "radarr-key",
      qualityProfileId: 7,
      rootFolderPath: "/movies",
      monitoring: true,
    },
    sonarr: {
      baseUrl: "https://sonarr.invalid/sonarr/",
      apiKey: "sonarr-key",
      qualityProfileId: 8,
      rootFolderPath: "/shows",
      monitorNewItems: "all",
    },
  });
});

void test("HTTP requires the explicit tailnet-only deployment acknowledgement", () => {
  const config = pluginConfig();
  assert.throws(
    () =>
      readPluginConfig({
        ...config,
        radarr: { ...(config.radarr as Record<string, unknown>), baseUrl: "http://radarr/" },
      }),
    /tailnetOnlyHttp=true/u,
  );
  assert.doesNotThrow(() =>
    readPluginConfig({
      ...config,
      tailnetOnlyHttp: true,
      radarr: { ...(config.radarr as Record<string, unknown>), baseUrl: "http://radarr/" },
    }),
  );
});

void test("rejects invalid service policy and unsafe URL components", () => {
  const config = pluginConfig();
  assert.throws(
    () =>
      readPluginConfig({
        ...config,
        sonarr: { ...(config.sonarr as Record<string, unknown>), monitorNewItems: "future" },
      }),
    /sonarr\.monitorNewItems/u,
  );
  assert.throws(
    () =>
      readPluginConfig({
        ...config,
        radarr: {
          ...(config.radarr as Record<string, unknown>),
          baseUrl: "https://user:password@radarr.invalid/",
        },
      }),
    /must not contain credentials/u,
  );
});
