# Viktor Telegram media-gate upgrade runbook

> **OWNER APPROVAL REQUIRED — DO NOT EXECUTE DURING PACKAGE REFRESH**

This procedure builds and validates the reviewed Phase 2 Viktor acquisition
flow, then upgrades only `openclaw-gateway` after separate owner approval. It
does not register the audiobook plugin, migrate state, change bot identity, or
modify Synology.

## Reviewed identities

- Branch: `viktor-acquisition-flow`
- Reviewed Phase 2 source HEAD:
  `54b36e5957ca3a353c7437b4ef2b07e18a50e068`
- Reviewed flow: selecting an edition invokes the Viktor release-acquisition
  callback directly; the separate `Get this book` step is not part of Phase 2.
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

## Phase 2 audiobook canary precondition

Before enabling the Phase 2 acquisition flow, retire the one known request from
the earlier selected-then-authorized flow:

- title: `Onyx Storm`
- request: `beba7972-4dc0-4523-a303-02d90f6336dd`

Use the same stable API client and Viktor actor that own the request. Read its
current status first and require `cancel_allowed: true`. Then call
`POST /api/v1/requests/beba7972-4dc0-4523-a303-02d90f6336dd/cancel/` with the
`requests:control` bearer token, `X-Viktor-Actor`, a fresh `Idempotency-Key`,
`Content-Type: application/json`, and an empty JSON object. Verify the response
and a subsequent status read report the request as canceled, and retain the
normal API audit event and control receipt. Never edit SQLite or delete the
request directly.

Keep the earlier release-selection and deployment-milestone evidence unchanged.
Create the fresh Phase 2 canary only after the old request is terminal. This
pre-production reset replaces migration machinery for this controlled rollout;
reassess migration before a public rollout with historical user cards.

## Build and validate the Phase 2 candidate

Run from the Viktor checkout. The reviewed extension list is intentionally
limited to `viktor-audiobooks`; do not add another extension without a new
review. Replace only the timestamp in `ROLLBACK_TAG` if desired. This section
builds and inspects images but does not recreate the gateway.

```bash
set -euo pipefail

export REVIEWED_BRANCH='viktor-acquisition-flow'
export REVIEWED_HEAD='54b36e5957ca3a353c7437b4ef2b07e18a50e068'
export REVIEWED_EXTENSIONS='viktor-audiobooks'
export TARGET_PLATFORM='linux/amd64'
export OPENCLAW_BASE_IMAGE='ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:f56744f2cbd2c2477c739158fbc4cf594300aa535767a87da3bcd9cafa150160'
export OPENCLAW_VIKTOR_BUILD_IMAGE="openclaw-local:viktor-build-${REVIEWED_HEAD}"
export CANDIDATE_TAG="openclaw-local:viktor-phase2-${REVIEWED_HEAD}"
export ROLLBACK_TAG='openclaw-local:viktor-pre-2026.7.1-2-20260819'

git status -sb
test -z "$(git status --porcelain)"
test "$(git branch --show-current)" = "$REVIEWED_BRANCH"
test "$(git rev-parse HEAD)" = "$REVIEWED_HEAD"
git merge-base --is-ancestor v2026.7.1-2 HEAD

RUNNING_CONTAINER_ID="$(docker compose ps -q openclaw-gateway)"
RUNNING_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$RUNNING_CONTAINER_ID")"
test "$RUNNING_IMAGE_ID" = 'sha256:142bc42a1333464142bb252e177bd5702f042f89645b7b22988c7f9d3e017bb2'
docker image tag "$RUNNING_IMAGE_ID" "$ROLLBACK_TAG"
test "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_TAG")" = "$RUNNING_IMAGE_ID"

DOCKER_DEFAULT_PLATFORM="$TARGET_PLATFORM" \
docker build --pull=false \
  --platform "$TARGET_PLATFORM" \
  --build-arg "OPENCLAW_EXTENSIONS=$REVIEWED_EXTENSIONS" \
  --label "org.opencontainers.image.revision=$REVIEWED_HEAD" \
  --tag "$OPENCLAW_VIKTOR_BUILD_IMAGE" \
  .

test "$(docker image inspect --format '{{.Architecture}}' "$OPENCLAW_VIKTOR_BUILD_IMAGE")" = \
  'amd64'
test "$(
  docker image inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$OPENCLAW_VIKTOR_BUILD_IMAGE"
)" = \
  "$REVIEWED_HEAD"

DOCKER_DEFAULT_PLATFORM="$TARGET_PLATFORM" \
OPENCLAW_BASE_IMAGE="$OPENCLAW_BASE_IMAGE" \
OPENCLAW_VIKTOR_BUILD_IMAGE="$OPENCLAW_VIKTOR_BUILD_IMAGE" \
OPENCLAW_IMAGE="$CANDIDATE_TAG" \
docker compose build --pull=false openclaw-gateway

test "$(docker image inspect --format '{{.Architecture}}' "$CANDIDATE_TAG")" = 'amd64'
test "$(docker image inspect --format '{{.Config.User}}' "$CANDIDATE_TAG")" = 'node'
test "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$CANDIDATE_TAG")" = \
  '["/opt/openclaw-telegram-media-gate/deployment/entrypoint.sh"]'
test "$(docker image inspect --format '{{json .Config.Cmd}}' "$CANDIDATE_TAG")" = \
  '["node","openclaw.mjs","gateway","--allow-unconfigured"]'

docker run --rm --network none --entrypoint node "$CANDIDATE_TAG" --version
docker run --rm --network none --entrypoint node "$CANDIDATE_TAG" -p \
  'require("./package.json").name + " " + require("./package.json").version'

for artifact in index.js openclaw.plugin.json; do
  VIKTOR_BUILD_SHA="$(
    docker run --rm --network none --entrypoint sha256sum \
      "$OPENCLAW_VIKTOR_BUILD_IMAGE" \
      "/app/dist/extensions/viktor-audiobooks/$artifact" | awk '{print $1}'
  )"
  CANDIDATE_VIKTOR_SHA="$(
    docker run --rm --network none --entrypoint sha256sum \
      "$CANDIDATE_TAG" \
      "/app/dist/extensions/viktor-audiobooks/$artifact" | awk '{print $1}'
  )"
  test -n "$VIKTOR_BUILD_SHA"
  test "$CANDIDATE_VIKTOR_SHA" = "$VIKTOR_BUILD_SHA"
done

docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=16m \
  -e OPENCLAW_TELEGRAM_MEDIA_RUNTIME_ROOT=/opt/openclaw-telegram-media-gate/scripts \
  --entrypoint node "$CANDIDATE_TAG" \
  /opt/openclaw-telegram-media-gate/deployment/tests/runtime-media-clarification-smoke.mjs
```

## Record fresh Phase 2 candidate evidence

Before any gateway recreation, add a new timestamped Phase 2 candidate record
under `deployment/telegram-media-gate/evidence/`. Do not overwrite or treat the
pre-Phase-2 `candidate-validation-2026.7.1-2-20260819T233511Z.json` record as
proof for this candidate.

The fresh evidence must record:

- branch `viktor-acquisition-flow` and reviewed HEAD
  `54b36e5957ca3a353c7437b4ef2b07e18a50e068`;
- the exact immutable `OPENCLAW_BASE_IMAGE`, reviewed extension list, donor
  image tag and ID, candidate tag, and candidate image ID;
- SHA-256 results for the bundled Viktor `index.js` and
  `openclaw.plugin.json` in both the donor and candidate images, including the
  successful equality checks;
- Phase 2 validation results for direct release acquisition, absence of the
  separate `Get this book` flow, selected-edition rendering, Telegram card
  length protection, and legacy callback compatibility;
- the exact commands and outcomes for focused Viktor tests, source readiness,
  image configuration inspection, version probes, and the network-disabled,
  read-only runtime smoke;
- any proof gap as an explicit non-passing result rather than copying an older
  success.

The candidate image ID and validation output are evidence only. They do not
authorize gateway recreation, plugin registration, or a Telegram canary.

## Owner-approved gateway activation

Proceed only after the fresh Phase 2 evidence is complete and the owner has
approved activation. Keep the reviewed values from the build section unchanged.

```bash
set -euo pipefail

export REVIEWED_HEAD='54b36e5957ca3a353c7437b4ef2b07e18a50e068'
export OPENCLAW_BASE_IMAGE='ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:f56744f2cbd2c2477c739158fbc4cf594300aa535767a87da3bcd9cafa150160'
export OPENCLAW_VIKTOR_BUILD_IMAGE="openclaw-local:viktor-build-${REVIEWED_HEAD}"
export CANDIDATE_TAG="openclaw-local:viktor-phase2-${REVIEWED_HEAD}"

OPENCLAW_BASE_IMAGE="$OPENCLAW_BASE_IMAGE" \
OPENCLAW_VIKTOR_BUILD_IMAGE="$OPENCLAW_VIKTOR_BUILD_IMAGE" \
OPENCLAW_IMAGE="$CANDIDATE_TAG" \
docker compose up -d --no-deps --force-recreate openclaw-gateway
```

Expected outage is one gateway container restart: Telegram polling and gateway
requests pause from old-container stop until the new health check succeeds.
Persistent `/home/node/.openclaw` and workspace bind mounts are reused unchanged.

## Post-start verification

```bash
set -euo pipefail

export REVIEWED_HEAD='54b36e5957ca3a353c7437b4ef2b07e18a50e068'
export OPENCLAW_BASE_IMAGE='ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:f56744f2cbd2c2477c739158fbc4cf594300aa535767a87da3bcd9cafa150160'
export OPENCLAW_VIKTOR_BUILD_IMAGE="openclaw-local:viktor-build-${REVIEWED_HEAD}"
export OPENCLAW_IMAGE="openclaw-local:viktor-phase2-${REVIEWED_HEAD}"

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
export OPENCLAW_BASE_IMAGE='ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:f56744f2cbd2c2477c739158fbc4cf594300aa535767a87da3bcd9cafa150160'
export OPENCLAW_VIKTOR_BUILD_IMAGE='openclaw-local:viktor-build-54b36e5957ca3a353c7437b4ef2b07e18a50e068'

test "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_TAG")" = \
  'sha256:142bc42a1333464142bb252e177bd5702f042f89645b7b22988c7f9d3e017bb2'
OPENCLAW_IMAGE="$ROLLBACK_TAG" \
OPENCLAW_BASE_IMAGE="$OPENCLAW_BASE_IMAGE" \
OPENCLAW_VIKTOR_BUILD_IMAGE="$OPENCLAW_VIKTOR_BUILD_IMAGE" \
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
