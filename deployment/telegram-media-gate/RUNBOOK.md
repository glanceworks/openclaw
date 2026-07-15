# Telegram media-gate deployment runbook

> **DO NOT EXECUTE  MANUAL OPERATOR PROCEDURE**

This checkout contains a fail-closed, evidence-complete source manifest. Readiness
passes, but no image has been built and no build is authorized by that result.
The Dockerfile has no default base image and accepts only the exact manifest-owned
reference. Separate manual operator authorization remains mandatory.

## 1. Resolve the upstream image identity

1. The reviewed OCI index digest is
   `sha256:7f4dfd4ed0d5469a4f12eccaa5f46b0c70fca802806be625dce782e69203e689`.
2. The independently inspected `linux/amd64` platform-manifest digest is
   `sha256:69895e31e3c36030b465b364365e9a22160737b000a0712082c7278e18f80e56`.
3. The only approved `OPENCLAW_BASE_IMAGE` value is
   `ghcr.io/openclaw/openclaw:2026.5.4@sha256:69895e31e3c36030b465b364365e9a22160737b000a0712082c7278e18f80e56`.
4. The index digest is provenance, not the build pin. Never substitute the index
   digest or the known-good local image ID for the platform-manifest digest.

## 2. Collect controlled bundle and version evidence

Use a controlled copy of the known-good image, never the live container,
production path, or production bind mount.

1. Establish a read-only version-probe contract for exactly OpenClaw `2026.5.4`.
2. Identify a bundle selector that resolves to exactly one regular file.
3. Record the exact bundle-relative path and original SHA-256.
4. Record exact occurrence counts for every structural anchor.
5. Apply the deployment-owned patch tool to the controlled copy.
6. Record the exact patched SHA-256 and confirm only the selected bundle changed.
7. Confirm the import URL is
   `file:///opt/openclaw-telegram-media-gate/scripts/telegram-media-gate.mjs`.

Do not infer filenames, hashes, counts, or version evidence from source names.

## 3. Complete readiness review

1. Confirm `OPENCLAW_BASE_IMAGE` exactly equals the approved platform-specific
   reference in section 1.
2. Run the non-Docker fixture tests.
3. Run the readiness validator against the tracked source layout; it must pass
   with no unresolved fields.
4. Review Dockerfile, Compose, runtime hashes, entrypoint, and verifier behavior.
5. Confirm no executable import comes from the mutable coordinator data root.
6. Treat readiness as source completeness only, not authorization to build.

## 4. Preserve rollback identity

Before any future build:

1. Verify the current known-good local image resolves exactly to
   `sha256:142bc42a1333464142bb252e177bd5702f042f89645b7b22988c7f9d3e017bb2`.
2. Apply a durable dated rollback tag without changing the image.
3. Record the rollback tag and image ID.
4. Do not treat the local ID as an upstream GHCR manifest digest.

## 5. Future manual build and inspection

Only after separate authorization:

1. Build only the `openclaw-gateway` image through the reviewed Compose file.
2. Inspect image identity, user, runtime hashes, version evidence, and patched
   bundle hash.
3. Require the exact guarded entrypoint array:
   `["/opt/openclaw-telegram-media-gate/deployment/entrypoint.sh"]`.
4. Require the exact explicit command array:
   `["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]`. The pinned
   upstream OpenClaw `2026.5.4` image was observed with `Config.Cmd = null`;
   the custom image supplies this command.
5. Confirm Compose does not override the image command.
6. Confirm `/app/dist` was patched at build time and is not runtime-writable.
7. Confirm the guarded wrapper only verifies and then delegates with
   `exec docker-entrypoint.sh "$@"`.
8. Confirm bind-mounted state remains writable by numeric UID/GID `1001:1001`.
9. This isolated source host has no Node runtime, so it cannot execute the image
   smoke test. After a candidate exists and test execution is separately
   authorized, use the following network-disabled, read-only pattern:

   ```bash
   docker run \
     --rm \
     --network none \
     --read-only \
     --tmpfs /tmp:rw,nosuid,nodev,size=16m \
     -e OPENCLAW_TELEGRAM_MEDIA_RUNTIME_ROOT=/opt/openclaw-telegram-media-gate/scripts \
     --entrypoint node \
     <candidate-tag> \
     /opt/openclaw-telegram-media-gate/deployment/tests/runtime-media-clarification-smoke.mjs
   ```

   This command is documentation only and does not authorize a build, container
   run, restart, or deployment.

## 6. Future gateway-only activation and validation

Only after separate deployment authorization:

1. Recreate only `openclaw-gateway`.
2. Verify existing Telegram access and ordinary `/start` behavior.
3. Redeem a valid private `/start media-<token>` invitation once.
4. Verify replay, invalid, and expired invitations are rejected.
5. Verify existing media commands and authorized-user behavior.
6. Confirm gateway health and runtime UID/GID `1001:1001`.

## 7. Rollback

If validation fails:

1. Restore `openclaw-local:playwright-runtime` from the rollback tag.
2. Recreate only `openclaw-gateway`.
3. Verify the restored image ID is the recorded known-good ID.
4. Revalidate health, Telegram behavior, UID/GID, and bind-mount write access.
5. Preserve failure evidence; never patch the live container.
