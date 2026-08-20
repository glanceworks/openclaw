# Telegram media-gate image evidence

The active deployment target is documented in
`registry-openclaw-2026.7.1-2-20260819T231706Z.json` and
`upstream-image-2026.7.1-2-20260819T231706Z.json`. The reviewed linux/amd64
platform bundle is `dist/telegram-ingress-spool-Dd3cDhXe.js`; its original
SHA-256 is `5e5d822dc380afd59a408b2e012e41a741db76951f54f3eb1125fc174c166b37`
and its deterministic patched SHA-256 is
`b3919853ad6fa913baed6def5194a2ddf15b40465a7192735e94b2752edcc1d1`.
Both structural anchors occur exactly once, the content selector identifies
exactly one bundle, and the derivation changes only that file.

`candidate-validation-2026.7.1-2-20260819T233511Z.json` records the local
candidate build, final image identity, controlled gateway health proof, complete
offline media behavior smoke, and rendered Compose security posture. The
candidate container used no network or published ports and was removed after
proof; the live Viktor service was not inspected or changed.

The official correction tag is `2026.7.1-2`; the packaged runtime version is
`2026.7.1`. Current readiness validates both identities independently.

## Historical 2026.5.4 evidence

This record summarizes evidence collected at `2026-07-13T04:55:21Z` from a
disposable stopped container created from local image
`sha256:142bc42a1333464142bb252e177bd5702f042f89645b7b22988c7f9d3e017bb2`.
That ID is rollback evidence only, not an upstream registry digest. No live
container or production filesystem was inspected.

All 5,085 archive-manifest hashes matched the safely extracted copy. The
startup-verifiable version contract reads immutable `/app/package.json` and
requires both `name == "openclaw"` and `version == "2026.5.4"`.

The content-count selector resolves exactly one controlled bundle,
`dist/bot-D-7bCSXH.js`. Its original SHA-256 is
`31f372aa5527d3db4769f3ac0c53547b395fb37defd70e62b5655a823f0e861b`.
Both production insertion anchors occur exactly once. The shared production
transform produced
`4b37c23bc7e335d4768f4d22f83ccacf7a204773e759522d25065d3b39d436a5`,
changed only that file among 5,077 controlled dist files, and was idempotent on
a second production-state pass. Startup verification accepted the controlled
patched copy and rejected the controlled original copy.

The upstream registry reference and verified manifest digest remain
intentionally unresolved.
