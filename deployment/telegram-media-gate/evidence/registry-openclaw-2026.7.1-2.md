# OpenClaw 2026.7.1-2 registry evidence

The official tag `ghcr.io/openclaw/openclaw:2026.7.1-2` resolves to OCI index
`sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac`.
Exactly one descriptor targets `linux/amd64`; its 5,225-byte platform manifest
is `sha256:f56744f2cbd2c2477c739158fbc4cf594300aa535767a87da3bcd9cafa150160`.

The approved build pin is therefore:

`ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:f56744f2cbd2c2477c739158fbc4cf594300aa535767a87da3bcd9cafa150160`

The index digest is provenance, not a build pin. The exact platform image was
pulled and inspected through a disposable, network-disabled container and a
stopped-container filesystem copy. No live Viktor container or Compose service
was inspected or changed.

The OCI tag and image label are `2026.7.1-2`; the packaged CLI and
`/app/package.json` version are `2026.7.1`. Both identities are validated by the
deployment manifest because they describe different release-artifact contracts.
