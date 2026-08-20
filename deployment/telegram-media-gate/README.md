# Telegram media-gate deployment preparation

This directory contains immutable Viktor media runtime assets, a fail-closed
deployment manifest, deterministic build-time patching, startup verification,
offline behavior fixtures, current OCI evidence, and the owner runbook.

The active target is the official OpenClaw correction image `2026.7.1-2` for
`linux/amd64`:

`ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:f56744f2cbd2c2477c739158fbc4cf594300aa535767a87da3bcd9cafa150160`

The tag resolves through OCI index
`sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac`.
The index is provenance; only the platform-manifest digest is an approved build
pin. The OCI tag and label are `2026.7.1-2`, while the packaged OpenClaw CLI and
`package.json` version are `2026.7.1`; readiness validates both identities.

The reviewed target bundle is `telegram-ingress-spool-Dd3cDhXe.js`. Its content
selector and both full structural anchors resolve exactly once. The upstream
handoff gained policy, dedupe, and prompt-boundary fields since `2026.5.4`, so
the handoff anchor was refreshed without changing the insertion behavior. The
immutable media-gate import remains
`file:///opt/openclaw-telegram-media-gate/scripts/telegram-media-gate.mjs`.

Runtime executable code is copied to `/opt/openclaw-telegram-media-gate`.
Mutable media configuration and state continue to use the configured data root;
the generated bundle never imports executable code from that mutable root.

Run source readiness checks with:

```bash
python3 -m unittest discover \
  -s deployment/telegram-media-gate/tests \
  -p 'test_*.py' \
  -v

python3 deployment/telegram-media-gate/tools/validate_readiness.py \
  --manifest deployment/telegram-media-gate/deployment-manifest.json \
  --runtime-root deployment/telegram-media-gate \
  --source-layout
```

The previous `2026.5.4` evidence files remain historical rollback provenance and
are not consumed by current readiness. A candidate image and controlled smoke
proof do not authorize live deployment. See `RUNBOOK.md`; owner approval is
required before any live build, recreation, plugin registration, or `/book`
canary.
