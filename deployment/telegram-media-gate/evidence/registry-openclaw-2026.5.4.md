# OpenClaw 2026.5.4 registry evidence

The reviewed tag `ghcr.io/openclaw/openclaw:2026.5.4` resolves to OCI index
`sha256:7f4dfd4ed0d5469a4f12eccaa5f46b0c70fca802806be625dce782e69203e689`.
That digest identifies the multi-platform index and is retained as provenance.

Exactly one index descriptor targets `linux/amd64`. Its independently inspected
platform manifest is 4,660 bytes with digest
`sha256:69895e31e3c36030b465b364365e9a22160737b000a0712082c7278e18f80e56`.
Therefore the exact deployment pin is
`ghcr.io/openclaw/openclaw:2026.5.4@sha256:69895e31e3c36030b465b364365e9a22160737b000a0712082c7278e18f80e56`.

The index digest must not replace the platform digest. The known-good local
Docker image ID remains rollback evidence only and is neither registry digest.
No image was pulled or built, and no container or Compose service was changed.

The archive's ten substantive evidence files match their recorded hashes. Its
hash manifest also contains a non-matching self-entry; the independently supplied
archive SHA-256 authenticates the completed archive and the raw index/platform
JSON bytes independently hash to the recorded OCI digests.
