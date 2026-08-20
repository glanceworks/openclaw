import type { PluginConfig } from "./types.js";

function requiredString(config: Record<string, unknown>, name: string, minLength: number): string {
  const value = config[name];
  if (typeof value !== "string" || value.trim().length < minLength) {
    throw new Error(`Missing or invalid Viktor Audiobooks configuration: ${name}.`);
  }
  return value.trim();
}

export function readPluginConfig(raw: Record<string, unknown> | undefined): PluginConfig {
  const config = raw ?? {};
  const applicationBaseUrl = requiredString(config, "applicationBaseUrl", 8);
  let parsed: URL;
  try {
    parsed = new URL(applicationBaseUrl);
  } catch {
    throw new Error("applicationBaseUrl must be an absolute HTTP or HTTPS URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("applicationBaseUrl must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("applicationBaseUrl must be an origin without credentials, path, query, or fragment.");
  }
  const tailnetOnlyHttp = config.tailnetOnlyHttp === true;
  if (parsed.protocol === "http:" && !tailnetOnlyHttp) {
    throw new Error(
      "HTTP requires tailnetOnlyHttp=true and a deployment route restricted to Tailscale.",
    );
  }
  return {
    applicationBaseUrl: `${parsed.origin}/`,
    tailnetOnlyHttp,
    createReadToken: requiredString(config, "createReadToken", 20),
    controlToken: requiredString(config, "controlToken", 20),
    actorDerivationSecret: requiredString(config, "actorDerivationSecret", 32),
    ...(typeof config.ownerNotificationTarget === "string" && config.ownerNotificationTarget.trim()
      ? { ownerNotificationTarget: config.ownerNotificationTarget.trim() }
      : {}),
    ownerToolEnabled: config.ownerToolEnabled !== false,
  };
}
