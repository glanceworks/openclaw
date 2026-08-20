# Viktor Telegram media-gate upgrade runbook

> **OWNER APPROVAL REQUIRED — DO NOT EXECUTE DURING PACKAGE REFRESH**

This procedure upgrades only `openclaw-gateway`. It does not register the
audiobook plugin, migrate state, change bot identity, or modify Synology.

## Reviewed identities

- Branch: `local/telegram-media-gate-2026.7.1-2`
- Reviewed source HEAD before refresh edits:
  `5f52866a10b6dbaed4c6618ec6002c04747ac8e3`
- Release tag: `v2026.7.1-2`
- OCI index:
  `sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac`
- linux/amd64 manifest:
  `sha256:f56744f2cbd2c2477c739158fbc4cf594300aa535767a87da3bcd9cafa150160`
- Approved `OPENCLAW_BASE_IMAGE`:
  `ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:f56744f2cbd2c2477c739158fbc4cf594300aa535767a87da3bcd9cafa150160`
- Recorded pre-upgrade image ID:
  `sha256:142bc42a1333464142bb252e177bd5702f042f89645b7b22988c7f9d3e017bb2`

The official image tag/label is `2026.7.1-2`; `openclaw --version` and
`/app/package.json` report `2026.7.1`. Candidate behavior validation uses a
network-disabled, read-only container with only a disposable `/tmp` tmpfs.

## Owner-approved live procedure

Run from the Viktor checkout after confirming its commit contains the reviewed
refresh diff. Replace only the timestamp in `ROLLBACK_TAG` if desired.

```bash
set -euo pipefail

export OPENCLAW_BASE_IMAGE='ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:f56744f2cbd2c2477c739158fbc4cf594300aa535767a87da3bcd9cafa150160'
export CANDIDATE_TAG='openclaw-local:playwright-runtime-2026.7.1-2'
export ROLLBACK_TAG='openclaw-local:viktor-pre-2026.7.1-2-20260819'

git status -sb
git branch --show-current
git rev-parse HEAD
git merge-base --is-ancestor v2026.7.1-2 HEAD

RUNNING_CONTAINER_ID="$(docker compose ps -q openclaw-gateway)"
RUNNING_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$RUNNING_CONTAINER_ID")"
test "$RUNNING_IMAGE_ID" = 'sha256:142bc42a1333464142bb252e177bd5702f042f89645b7b22988c7f9d3e017bb2'
docker image tag "$RUNNING_IMAGE_ID" "$ROLLBACK_TAG"
test "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_TAG")" = "$RUNNING_IMAGE_ID"

OPENCLAW_BASE_IMAGE="$OPENCLAW_BASE_IMAGE" \
OPENCLAW_IMAGE="$CANDIDATE_TAG" \
docker compose build --pull=false openclaw-gateway

test "$(docker image inspect --format '{{.Config.User}}' "$CANDIDATE_TAG")" = 'node'
test "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$CANDIDATE_TAG")" = \
  '["/opt/openclaw-telegram-media-gate/deployment/entrypoint.sh"]'
test "$(docker image inspect --format '{{json .Config.Cmd}}' "$CANDIDATE_TAG")" = \
  '["node","openclaw.mjs","gateway","--allow-unconfigured"]'

docker run --rm --network none --entrypoint node "$CANDIDATE_TAG" --version
docker run --rm --network none --entrypoint node "$CANDIDATE_TAG" -p \
  'require("./package.json").name + " " + require("./package.json").version'
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=16m \
  -e OPENCLAW_TELEGRAM_MEDIA_RUNTIME_ROOT=/opt/openclaw-telegram-media-gate/scripts \
  --entrypoint node "$CANDIDATE_TAG" \
  /opt/openclaw-telegram-media-gate/deployment/tests/runtime-media-clarification-smoke.mjs

OPENCLAW_BASE_IMAGE="$OPENCLAW_BASE_IMAGE" \
OPENCLAW_IMAGE="$CANDIDATE_TAG" \
docker compose up -d --no-deps --force-recreate openclaw-gateway
```

Expected outage is one gateway container restart: Telegram polling and gateway
requests pause from old-container stop until the new health check succeeds.
Persistent `/home/node/.openclaw` and workspace bind mounts are reused unchanged.

## Post-start verification

```bash
set -euo pipefail

GATEWAY_CONTAINER_ID="$(docker compose ps -q openclaw-gateway)"
GATEWAY_PORT="$(docker compose port openclaw-gateway 18789 | sed 's/.*://')"
test -n "$GATEWAY_CONTAINER_ID"
test -n "$GATEWAY_PORT"
test "$(docker inspect --format '{{.State.Running}}' "$GATEWAY_CONTAINER_ID")" = true

docker exec "$GATEWAY_CONTAINER_ID" node --version
docker exec "$GATEWAY_CONTAINER_ID" node openclaw.mjs --version
docker inspect --format '{{json .State.Health}}' "$GATEWAY_CONTAINER_ID"
curl --fail --silent --show-error \
  "http://127.0.0.1:${GATEWAY_PORT}/healthz"
```

Then perform Telegram canaries using the existing owner, media-rights, and
unauthorized test identities:

1. Owner sends a normal non-media request and receives ordinary Viktor behavior.
2. Owner verifies `/movie` and `/show` still work.
3. Media-rights user verifies `/movie` works.
4. Media-rights user verifies `/show` works.
5. Media-rights user sends a non-approved free-form request and receives the
   existing canned restricted response; no agent/tool turn occurs.
6. Unauthorized user sends a media command and receives the existing
   reject/ignore behavior; no media operation occurs.
7. Confirm Telegram gateway health/polling logs contain no startup or delivery
   errors.

Do not register or enable `viktor-audiobooks` until every gateway smoke passes.

## Rollback

If any build inspection, startup, health, or Telegram canary fails:

```bash
set -euo pipefail

export ROLLBACK_TAG='openclaw-local:viktor-pre-2026.7.1-2-20260819'
export OPENCLAW_IMAGE="$ROLLBACK_TAG"

test "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_TAG")" = \
  'sha256:142bc42a1333464142bb252e177bd5702f042f89645b7b22988c7f9d3e017bb2'
OPENCLAW_IMAGE="$ROLLBACK_TAG" \
docker compose up -d --no-deps --force-recreate openclaw-gateway

ROLLBACK_CONTAINER_ID="$(docker compose ps -q openclaw-gateway)"
ROLLBACK_GATEWAY_PORT="$(docker compose port openclaw-gateway 18789 | sed 's/.*://')"
test "$(docker inspect --format '{{.Image}}' "$ROLLBACK_CONTAINER_ID")" = \
  'sha256:142bc42a1333464142bb252e177bd5702f042f89645b7b22988c7f9d3e017bb2'
docker inspect --format '{{json .State.Health}}' "$ROLLBACK_CONTAINER_ID"
curl --fail --silent --show-error \
  "http://127.0.0.1:${ROLLBACK_GATEWAY_PORT}/healthz"
```

Repeat the owner and existing `/movie`/`/show` smoke checks after rollback.
Preserve candidate logs and image identity for diagnosis; do not patch a live
container.
