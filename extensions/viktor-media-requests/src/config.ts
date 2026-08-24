export type ServiceConfig = {
  baseUrl: string;
  apiKey: string;
  qualityProfileId: number;
  rootFolderPath: string;
};

export type ViktorMediaConfig = {
  radarr: ServiceConfig & { monitoring: boolean };
  sonarr: ServiceConfig & { monitorNewItems: "all" | "none" };
};

function requiredObject(
  config: Record<string, unknown>,
  name: "radarr" | "sonarr",
): Record<string, unknown> {
  const value = config[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Missing or invalid Viktor Media Requests configuration: ${name}.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(config: Record<string, unknown>, name: string): string {
  const value = config[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing or invalid Viktor Media Requests configuration: ${name}.`);
  }
  return value.trim();
}

function requiredPositiveInteger(config: Record<string, unknown>, name: string): number {
  const value = config[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Missing or invalid Viktor Media Requests configuration: ${name}.`);
  }
  return value;
}

function serviceConfig(
  raw: Record<string, unknown>,
  name: "radarr" | "sonarr",
  tailnetOnlyHttp: boolean,
): ServiceConfig {
  const baseUrl = requiredString(raw, "baseUrl");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${name}.baseUrl must be an absolute HTTP or HTTPS URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name}.baseUrl must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name}.baseUrl must not contain credentials, query, or fragment.`);
  }
  if (parsed.protocol === "http:" && !tailnetOnlyHttp) {
    throw new Error(
      "HTTP requires tailnetOnlyHttp=true and a Tailscale-restricted deployment route.",
    );
  }
  return {
    baseUrl: `${parsed.href.replace(/\/+$/u, "")}/`,
    apiKey: requiredString(raw, "apiKey"),
    qualityProfileId: requiredPositiveInteger(raw, "qualityProfileId"),
    rootFolderPath: requiredString(raw, "rootFolderPath"),
  };
}

export function readPluginConfig(raw: Record<string, unknown> | undefined): ViktorMediaConfig {
  const config = raw ?? {};
  const tailnetOnlyHttp = config.tailnetOnlyHttp === true;
  const radarr = requiredObject(config, "radarr");
  const sonarr = requiredObject(config, "sonarr");
  if (typeof radarr.monitoring !== "boolean") {
    throw new Error("Missing or invalid Viktor Media Requests configuration: radarr.monitoring.");
  }
  const sonarrMonitorNewItems = requiredString(sonarr, "monitorNewItems");
  if (sonarrMonitorNewItems !== "all" && sonarrMonitorNewItems !== "none") {
    throw new Error(
      "Missing or invalid Viktor Media Requests configuration: sonarr.monitorNewItems.",
    );
  }
  return {
    radarr: { ...serviceConfig(radarr, "radarr", tailnetOnlyHttp), monitoring: radarr.monitoring },
    sonarr: {
      ...serviceConfig(sonarr, "sonarr", tailnetOnlyHttp),
      monitorNewItems: sonarrMonitorNewItems,
    },
  };
}
