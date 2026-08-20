import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationApi } from "./api-client.js";
import { readPluginConfig } from "./config.js";

const secrets = {
  createReadToken: "create-read-token-not-a-real-secret",
  controlToken: "control-token-not-a-real-secret",
  actorDerivationSecret: "long-lived-test-identity-secret-value",
};

test("explicitly acknowledged tailnet HTTP configuration is accepted", () => {
  const config = readPluginConfig({
    ...secrets,
    applicationBaseUrl: "http://tailnet-host.invalid:18000/",
    tailnetOnlyHttp: true,
  });

  assert.equal(config.applicationBaseUrl, "http://tailnet-host.invalid:18000/");
  assert.equal(config.tailnetOnlyHttp, true);
  assert.doesNotThrow(
    () => new ApplicationApi(
      config.applicationBaseUrl,
      config.createReadToken,
      config.controlToken,
      config.tailnetOnlyHttp,
    ),
  );
});

test("HTTP requires an explicit tailnet-only deployment acknowledgement", () => {
  assert.throws(
    () => readPluginConfig({
      ...secrets,
      applicationBaseUrl: "http://tailnet-host.invalid:18000/",
    }),
    /tailnetOnlyHttp=true/u,
  );
  assert.throws(
    () => new ApplicationApi(
      "http://tailnet-host.invalid:18000/",
      secrets.createReadToken,
      secrets.controlToken,
      false,
    ),
    /explicitly acknowledged tailnet route/u,
  );
});

test("private HTTPS remains optional and does not require the HTTP acknowledgement", () => {
  const config = readPluginConfig({
    ...secrets,
    applicationBaseUrl: "https://private-host.invalid/",
  });

  assert.equal(config.tailnetOnlyHttp, false);
  assert.doesNotThrow(
    () => new ApplicationApi(
      config.applicationBaseUrl,
      config.createReadToken,
      config.controlToken,
      config.tailnetOnlyHttp,
    ),
  );
});

test("base URL rejects embedded credentials and non-origin URL components", () => {
  for (const applicationBaseUrl of [
    "http://user:password@tailnet-host.invalid:18000/",
    "http://tailnet-host.invalid:18000/application/",
    "http://tailnet-host.invalid:18000/?target=other",
    "http://tailnet-host.invalid:18000/#fragment",
  ]) {
    assert.throws(
      () => readPluginConfig({
        ...secrets,
        applicationBaseUrl,
        tailnetOnlyHttp: true,
      }),
      /origin without credentials/u,
    );
  }
});
