import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { OpenClawPluginApi, OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { plugin } from "./index.js";

const pluginConfig = {
  tailnetOnlyHttp: false,
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

void test("registers Telegram-only movie and show commands with plugin-owned authorization", () => {
  const commands: OpenClawPluginCommandDefinition[] = [];
  assert.ok(plugin.register);
  plugin.register({
    registrationMode: "full",
    pluginConfig,
    registerCommand(command: OpenClawPluginCommandDefinition) {
      commands.push(command);
    },
  } as unknown as OpenClawPluginApi);

  assert.deepEqual(
    commands.map(({ name, acceptsArgs, requireAuth, channels }) => ({
      name,
      acceptsArgs,
      requireAuth,
      channels,
    })),
    [
      { name: "movie", acceptsArgs: true, requireAuth: false, channels: ["telegram"] },
      { name: "show", acceptsArgs: true, requireAuth: false, channels: ["telegram"] },
    ],
  );
});

void test("skips backend configuration during tool discovery", () => {
  let registrations = 0;
  const register = plugin.register;
  assert.ok(register);
  assert.doesNotThrow(() =>
    register({
      registrationMode: "tool-discovery",
      pluginConfig: {},
      registerCommand() {
        registrations += 1;
      },
    } as unknown as OpenClawPluginApi),
  );
  assert.equal(registrations, 0);
});

void test("ships disabled so the legacy overlay remains the only owner before cutover", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { enabledByDefault?: boolean; activation?: unknown };
  assert.equal(manifest.enabledByDefault, false);
  assert.deepEqual(manifest.activation, { onStartup: true });
});
