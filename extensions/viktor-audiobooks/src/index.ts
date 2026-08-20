import { Type } from "typebox";
import {
  definePluginEntry,
  type OpenClawPluginDefinition,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";

import { ApplicationApi } from "./api-client.js";
import { readPluginConfig } from "./config.js";
import { ViktorAudiobookController } from "./controller.js";
import { openPluginStores } from "./state.js";
import type { Route } from "./types.js";

export function ownerToolRoute(ctx: OpenClawPluginToolContext): Route | null {
  const delivery = ctx.deliveryContext;
  if (
    ctx.messageChannel !== "telegram" ||
    ctx.senderIsOwner !== true ||
    !ctx.requesterSenderId ||
    delivery?.channel !== "telegram" ||
    typeof delivery.to !== "string"
  ) {
    return null;
  }
  const chatMatch = /^(?:telegram:)?([1-9][0-9]*)$/u.exec(delivery.to);
  const senderMatch = /^(?:telegram:)?([1-9][0-9]*)$/u.exec(ctx.requesterSenderId);
  if (!chatMatch?.[1] || chatMatch[1] !== senderMatch?.[1]) return null;
  return {
    chatId: chatMatch[1],
    ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
    ...(typeof delivery.threadId === "number" ? { threadId: delivery.threadId } : {}),
  };
}

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "viktor-audiobooks",
  name: "Viktor Audiobooks",
  description: "Deterministic private audiobook requests for Viktor on Telegram.",
  register(api) {
    if (api.registrationMode !== "full" && api.registrationMode !== "tool-discovery") return;
    const config = readPluginConfig(api.pluginConfig);
    const stores = openPluginStores(api);
    const application = new ApplicationApi(
      config.applicationBaseUrl,
      config.createReadToken,
      config.controlToken,
      config.tailnetOnlyHttp,
    );
    const controller = new ViktorAudiobookController(api, config, application, stores);

    api.registerCommand({
      name: "book",
      description: "Request and track an audiobook.",
      acceptsArgs: true,
      requireAuth: true,
      channels: ["telegram"],
      handler: async (ctx) => await controller.handleBookCommand(ctx),
    });

    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: "vab",
      handler: async (ctx: unknown) =>
        await controller.handleCallback(ctx as Parameters<typeof controller.handleCallback>[0]),
    });

    if (config.ownerToolEnabled) {
      api.registerTool(
        (ctx) => {
          const route = ownerToolRoute(ctx);
          if (!route || !ctx.requesterSenderId) return null;
          const trustedSenderId = ctx.requesterSenderId;
          return {
            name: "create_book",
            label: "Create audiobook request",
            description: "Create an audiobook request for the current owner in this Telegram chat.",
            parameters: Type.Object({
              title: Type.String({ minLength: 1, maxLength: 500 }),
              author: Type.Optional(Type.String({ maxLength: 300 })),
            }),
            async execute(_id, params) {
              const values = params as { title: string; author?: string };
              const text = await controller.createFromOwnerTool({
                title: values.title,
                ...(values.author === undefined ? {} : { author: values.author }),
                trustedSenderId,
                route,
              });
              return { content: [{ type: "text" as const, text }], details: {} };
            },
          };
        },
        { name: "create_book", optional: true },
      );
    }

    api.registerService({
      id: "viktor-audiobook-poller",
      start: () => controller.start(),
      stop: () => controller.stop(),
    });
  },
});

export default plugin;
