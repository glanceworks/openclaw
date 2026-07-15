# Telegram media-gate export package

This is a deterministic export package built from exact committed Git blobs, not from working-tree copies.

## Provenance

- Runtime-source commit: `580007d45bd4e903d829d1f17ed61dd4341e0dcd`
- Patch-reference commit: `6049d34d751333d8d0dd6a77d506c9a42d19d495`
- Export created: `2026-07-12T22:37:17+00:00`

### Runtime refresh overlay

Three immutable runtime modules were refreshed from coordinator commit
`2168d504507edf6117a13f9b9aeef2ac88808bb2` (parent
`580007d45bd4e903d829d1f17ed61dd4341e0dcd`) using reviewed archive SHA-256
`659a3b69e5b4bd05f5d8483d0789a8172bda7d162259eb982b6fb0daabcb292b`.
The exact file-level overlay is recorded in
`year-clarification-refresh-2168d50.json`; the original export manifest remains
unchanged as historical provenance. The test-only coordinator source was not
copied into the image runtime. The exact historical `lookup_error` was not
reproduced.

## What this package contains

- `payload/runtime/`
  - exact runtime-source files extracted from commit `580007d45bd4e903d829d1f17ed61dd4341e0dcd`
  - preserves `scripts/` and `config/` relative layout
  - intended eventual image-owned root: `/opt/openclaw-telegram-media-gate`
- `payload/test-only/`
  - exact committed tests for path-boundary verification only
  - not image runtime assets
- `payload/reference-only/`
  - historical patch-helper reference extracted from commit `6049d34d751333d8d0dd6a77d506c9a42d19d495`

## Critical warnings

### `payload/reference-only/scripts/apply-telegram-media-gate-startup-patch.mjs`

This file is **reference-only**.

It is:
- not suitable for direct production use
- not to be copied into the final image unchanged
- hardcoded to `/app/dist`
- missing version and hash guards
- importing mutable coordinator executable code

## Mutable-data contract

- default mutable-data root: `/home/node/.openclaw/workspace-coordinator`
- override environment variable: `OPENCLAW_TELEGRAM_MEDIA_DATA_ROOT`
- command metadata remains source-relative and should resolve from the immutable source tree

## Exclusions

This package intentionally excludes:
- `.env`
- access configuration contents
- media backend configuration contents
- runtime state
- logs
- Telegram IDs
- invite tokens or hashes
- credentials
- `/app/dist`
- `scripts/telegram-media-runtime-smoke.mjs`

## Review/use constraints

- do not treat this export as activated or deployed
- do not copy the reference-only patch helper into production unchanged
- do not infer unresolved deployment values from this package
- verify final image placement, target bundle path, hash guards, and patch anchors before any deployment work
