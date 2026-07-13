# Telegram media-gate deployment preparation

This directory contains immutable runtime assets exported from reviewed commits,
a fail-closed deployment manifest, deterministic build-time patching, read-only
startup verification, synthetic fixtures, and the manual operator runbook.

The reviewed source manifest is complete and the readiness validator now passes.
No image has been built. Readiness means only that an explicitly authorized
operator may proceed after preserving the rollback image. The approved
`linux/amd64` base reference is
`ghcr.io/openclaw/openclaw:2026.5.4@sha256:69895e31e3c36030b465b364365e9a22160737b000a0712082c7278e18f80e56`.
The Dockerfile requires `OPENCLAW_BASE_IMAGE` to equal that manifest-owned
reference exactly before readiness validation or patching can complete.

Runtime executable code is copied to `/opt/openclaw-telegram-media-gate`.
Mutable media configuration and state continue to use the configured data root;
the generated OpenClaw bundle never imports executable code from that root.

Run the package-independent fixture suite with:

```bash
python3 -m unittest discover \
  -s deployment/telegram-media-gate/tests \
  -p 'test_*.py' \
  -v
```

The registry index digest identifies the multi-platform index; it is retained as
provenance but is not the build pin. The selected `linux/amd64` platform-manifest
digest is the build pin. The known-good local image ID recorded in `RUNBOOK.md`
is rollback evidence for the local host only and is neither registry digest.
Explicit manual authorization is still required, and a durable rollback tag must
be recorded before the first build.

The checked-in upstream Dockerfile supplies the inherited command
`node openclaw.mjs gateway --allow-unconfigured`. This integration intentionally
does not replace it: the deployment entrypoint verifies the built image and then
delegates to `docker-entrypoint.sh` with the inherited command arguments intact.
