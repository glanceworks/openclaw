import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { ArrClient } from "./arr-client.js";
import { readPluginConfig } from "./config.js";
import { ViktorMediaController } from "./controller.js";

export const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "viktor-media-requests",
  name: "Viktor Media Requests",
  description: "Deterministic private movie and show requests for Viktor on Telegram.",
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const controller = new ViktorMediaController(
      new ArrClient(readPluginConfig(api.pluginConfig)),
      api.config,
    );

    api.registerCommand({
      name: "movie",
      description: "Request a movie through Radarr.",
      acceptsArgs: true,
      requireAuth: false,
      channels: ["telegram"],
      handler: async (ctx) => await controller.handle("movie", ctx),
    });
    api.registerCommand({
      name: "show",
      description: "Request a show through Sonarr.",
      acceptsArgs: true,
      requireAuth: false,
      channels: ["telegram"],
      handler: async (ctx) => await controller.handle("show", ctx),
    });
  },
});

export default plugin;
