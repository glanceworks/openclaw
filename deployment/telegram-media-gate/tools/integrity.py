#!/usr/bin/env python3
'Fail-closed integrity primitives for the Telegram media-gate image patch.'
from __future__ import annotations
import hashlib, json, pathlib, re
from typing import Any

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PINNED_IMAGE_RE = re.compile(
    r"^ghcr\.io/openclaw/openclaw:(?P<tag>[0-9A-Za-z._-]+)@sha256:[0-9a-f]{64}$"
)

class IntegrityError(RuntimeError):
    pass

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def sha256_file(path: pathlib.Path) -> str:
    return sha256_bytes(path.read_bytes())

def load_manifest(path: pathlib.Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IntegrityError(f"cannot load deployment manifest: {exc}") from exc
    if not isinstance(value, dict):
        raise IntegrityError("deployment manifest must be a JSON object")
    return value

def _field(value: dict[str, Any], dotted: str) -> Any:
    current: Any = value
    for part in dotted.split("."):
        if not isinstance(current, dict) or part not in current:
            raise IntegrityError(f"required manifest field is missing: {dotted}")
        current = current[part]
    return current

def ensure_ready(manifest: dict[str, Any]) -> None:
    required = [
        "expected_release_tag",
        "expected_openclaw_version",
        "upstream_base_image.registry_index_digest",
        "upstream_base_image.verified_manifest_digest",
        "upstream_base_image.verified_manifest_digest_kind",
        "upstream_base_image.selected_platform.os",
        "upstream_base_image.selected_platform.architecture",
        "upstream_base_image.reference",
        "upstream_base_image.evidence_record",
        "upstream_base_image.local_known_good_image_id",
        "upstream_base_image.local_image_id_role",
        "version_probe.contract",
        "version_probe.evidence",
        "bundle.selector",
        "bundle.expected_path",
        "bundle.original_sha256",
        "bundle.patched_sha256",
    ]
    unresolved = [name for name in required if _field(manifest, name) is None]
    anchors = _field(manifest, "bundle.structural_anchors")
    if not isinstance(anchors, list) or not anchors:
        unresolved.append("bundle.structural_anchors")
    else:
        for index, anchor in enumerate(anchors):
            if not isinstance(anchor, dict) or anchor.get("expected_count") is None:
                unresolved.append(f"bundle.structural_anchors[{index}].expected_count")
    if unresolved:
        raise IntegrityError("deployment manifest is unresolved: " + ", ".join(unresolved))
    digest = _field(manifest, "upstream_base_image.verified_manifest_digest")
    reference = _field(manifest, "upstream_base_image.reference")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise IntegrityError("verified upstream manifest digest is malformed")
    match = PINNED_IMAGE_RE.fullmatch(reference) if isinstance(reference, str) else None
    if match is None:
        raise IntegrityError("upstream base-image reference is not an exact OpenClaw tag-and-digest pin")
    if match.group("tag") != _field(manifest, "expected_release_tag"):
        raise IntegrityError("base-image tag does not match expected release tag")
    if not reference.endswith("@" + digest):
        raise IntegrityError("base-image reference and verified digest disagree")
    index_digest = _field(manifest, "upstream_base_image.registry_index_digest")
    if not isinstance(index_digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", index_digest):
        raise IntegrityError("registry index digest is malformed")
    if index_digest == digest:
        raise IntegrityError("registry index digest must not be used as the platform build pin")
    if _field(manifest, "upstream_base_image.verified_manifest_digest_kind") != "platform-manifest":
        raise IntegrityError("verified base-image digest is not identified as a platform manifest")
    platform = _field(manifest, "upstream_base_image.selected_platform")
    if platform != {"os": "linux", "architecture": "amd64"}:
        raise IntegrityError("selected base-image platform must be exactly linux/amd64")
    evidence_record = _field(manifest, "upstream_base_image.evidence_record")
    if not isinstance(evidence_record, str) or not evidence_record.startswith("evidence/"):
        raise IntegrityError("registry evidence record path is malformed")
    local_image_id = _field(manifest, "upstream_base_image.local_known_good_image_id")
    if not isinstance(local_image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", local_image_id):
        raise IntegrityError("known-good local image ID is malformed")
    if local_image_id in (digest, index_digest):
        raise IntegrityError("known-good local image ID cannot be used as a registry digest")
    if _field(manifest, "upstream_base_image.local_image_id_role") != (
        "rollback evidence only; not an upstream registry digest"
    ):
        raise IntegrityError("known-good local image ID role is malformed")
    for field in ("bundle.original_sha256", "bundle.patched_sha256"):
        value = _field(manifest, field)
        if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
            raise IntegrityError(f"{field} is malformed")
    for anchor in anchors:
        if not isinstance(anchor.get("text"), str) or not anchor["text"]:
            raise IntegrityError("structural anchor text must be non-empty")
        if not isinstance(anchor.get("expected_count"), int) or anchor["expected_count"] < 1:
            raise IntegrityError("structural anchor counts must be positive integers")


def verify_base_image_reference(manifest: dict[str, Any], supplied_reference: str) -> None:
    ensure_ready(manifest)
    expected = _field(manifest, "upstream_base_image.reference")
    if supplied_reference != expected:
        raise IntegrityError(
            f"OPENCLAW_BASE_IMAGE must exactly equal the reviewed manifest reference {expected!r}"
        )

def verify_runtime_files(manifest: dict[str, Any], runtime_root: pathlib.Path, use_image_paths: bool = True) -> None:
    root = runtime_root.resolve(strict=True)
    files = manifest.get("runtime_files")
    if not isinstance(files, list) or len(files) != 8:
        raise IntegrityError("deployment manifest must declare exactly eight runtime files")
    for entry in files:
        key = "image_relative_path" if use_image_paths else "source_path"
        rel, expected = entry.get(key), entry.get("sha256")
        if not isinstance(rel, str) or not isinstance(expected, str):
            raise IntegrityError("runtime file declaration is malformed")
        candidate = runtime_root / rel
        if candidate.is_symlink() or not candidate.is_file():
            raise IntegrityError(f"runtime file missing or unsafe: {rel}")
        resolved = candidate.resolve(strict=True)
        if root not in resolved.parents:
            raise IntegrityError(f"runtime file escapes root: {rel}")
        if sha256_file(resolved) != expected:
            raise IntegrityError(f"runtime file hash mismatch: {rel}")

def verify_version(manifest: dict[str, Any], app_root: pathlib.Path) -> None:
    contract = _field(manifest, "version_probe.contract")
    if not isinstance(contract, dict) or contract.get("kind") != "json-file":
        raise IntegrityError("unsupported or unresolved OpenClaw version-probe contract")
    rel, checks = contract.get("path"), contract.get("checks")
    if not isinstance(rel, str) or not isinstance(checks, list) or not checks:
        raise IntegrityError("version-probe contract is malformed")
    required = {
        (("name",), "openclaw"),
        (("version",), manifest.get("expected_openclaw_version")),
    }
    declared: set[tuple[tuple[str, ...], Any]] = set()
    root = app_root.resolve(strict=True)
    candidate = app_root / rel
    if candidate.is_symlink() or not candidate.is_file():
        raise IntegrityError("version-probe file is missing or unsafe")
    resolved = candidate.resolve(strict=True)
    if root not in resolved.parents:
        raise IntegrityError("version-probe file escapes application root")
    try:
        document: Any = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IntegrityError(f"cannot read version-probe JSON: {exc}") from exc
    for check in checks:
        if not isinstance(check, dict):
            raise IntegrityError("version-probe field check is malformed")
        fields, expected = check.get("field_path"), check.get("expected")
        if not isinstance(expected, str) or not isinstance(fields, list) or not fields or not all(
            isinstance(field, str) and field for field in fields
        ):
            raise IntegrityError("version-probe field check is malformed")
        value = document
        for field in fields:
            if not isinstance(value, dict) or field not in value:
                raise IntegrityError("version-probe field is missing")
            value = value[field]
        label = ".".join(fields)
        if value != expected:
            raise IntegrityError(
                f"OpenClaw {label} mismatch: expected {expected!r}, got {value!r}"
            )
        declared.add((tuple(fields), expected))
    if not required.issubset(declared):
        raise IntegrityError("version-probe contract must verify exact package name and version")

def resolve_target(manifest: dict[str, Any], dist_root: pathlib.Path | None, target_file: pathlib.Path | None) -> pathlib.Path:
    if target_file is not None:
        candidates = [target_file] if target_file.is_file() and not target_file.is_symlink() else []
    else:
        if dist_root is None:
            raise IntegrityError("an explicit dist root or target file is required")
        selector = _field(manifest, "bundle.selector")
        if not isinstance(selector, dict):
            raise IntegrityError("unsupported or unresolved bundle selector")
        pattern = selector.get("pattern")
        pattern_path = pathlib.PurePosixPath(pattern) if isinstance(pattern, str) else None
        if (
            pattern_path is None
            or not pattern
            or pattern_path.is_absolute()
            or ".." in pattern_path.parts
        ):
            raise IntegrityError("bundle selector pattern is unsafe")
        files = sorted(p for p in dist_root.glob(pattern) if p.is_file() and not p.is_symlink())
        if selector.get("kind") == "relative-glob":
            candidates = files
        elif selector.get("kind") == "content-counts":
            needles = selector.get("needles")
            if not isinstance(needles, list) or not needles:
                raise IntegrityError("content-count selector is malformed")
            parsed: list[tuple[bytes, int]] = []
            for needle in needles:
                if not isinstance(needle, dict):
                    raise IntegrityError("content-count selector needle is malformed")
                text, expected = needle.get("text"), needle.get("expected_count")
                if not isinstance(text, str) or not text or not isinstance(expected, int) or expected < 1:
                    raise IntegrityError("content-count selector needle is malformed")
                parsed.append((text.encode("utf-8"), expected))
            candidates = [
                path for path in files
                if all(path.read_bytes().count(text) == expected for text, expected in parsed)
            ]
        else:
            raise IntegrityError("unsupported or unresolved bundle selector")
    if len(candidates) != 1:
        raise IntegrityError(f"expected exactly one target bundle, found {len(candidates)}")
    selected = candidates[0].resolve(strict=True)
    if dist_root is not None:
        root = dist_root.resolve(strict=True)
        if root not in selected.parents:
            raise IntegrityError("selected bundle escapes dist root")
        expected_path = _field(manifest, "bundle.expected_path")
        actual_path = selected.relative_to(root).as_posix()
        if actual_path != expected_path:
            raise IntegrityError(f"selected bundle path mismatch: expected {expected_path!r}, got {actual_path!r}")
    return selected

def verify_anchors(manifest: dict[str, Any], data: bytes) -> None:
    for anchor in _field(manifest, "bundle.structural_anchors"):
        actual = data.count(anchor["text"].encode("utf-8"))
        expected = anchor["expected_count"]
        if actual != expected:
            raise IntegrityError(
                f"structural anchor {anchor['name']!r} count mismatch: expected {expected}, got {actual}"
            )

def anchor_by_name(manifest: dict[str, Any], name: str) -> str:
    matches = [a["text"] for a in _field(manifest, "bundle.structural_anchors") if a.get("name") == name]
    if len(matches) != 1:
        raise IntegrityError(f"expected exactly one manifest anchor named {name!r}")
    return matches[0]

def render_patched_bytes(manifest: dict[str, Any], original: bytes) -> bytes:
    patch = _field(manifest, "patch")
    helper_anchor = anchor_by_name(manifest, patch["helper_anchor_name"])
    handoff_anchor = anchor_by_name(manifest, patch["handoff_anchor_name"])
    marker, module_url = patch["marker"], patch["module_import_url"]
    if module_url != manifest.get("patched_import_url"):
        raise IntegrityError("patch module URL disagrees with deployment manifest")
    helper_template = r'''const TELEGRAM_MEDIA_GATE_PATCH_MARKER = __MARKER__;
const TELEGRAM_MEDIA_GATE_MODULE_URL = __MODULE_URL__;
let telegramMediaGateModulePromise = null;
async function loadTelegramMediaGateModule() {
	telegramMediaGateModulePromise ??= import(TELEGRAM_MEDIA_GATE_MODULE_URL);
	return await telegramMediaGateModulePromise;
}
async function evaluateTelegramMediaGateDecision(params) {
	try {
		const mod = await loadTelegramMediaGateModule();
		if (!mod || typeof mod.evaluateTelegramMediaAccess !== "function") return null;
		return mod.evaluateTelegramMediaAccess({
			provider: "telegram",
			senderId: params.senderId,
			chatId: params.chatId,
			text: params.text,
			botUsername: params.botUsername
		});
	} catch (err) {
		params.runtime?.error?.(danger("telegram media gate load failed: " + String(err)));
		return null;
	}
}
async function applyTelegramMediaGateDecision(params) {
	const decision = await evaluateTelegramMediaGateDecision({
		chatId: params.chatId,
		senderId: params.senderId,
		text: params.text,
		botUsername: params.bot?.botInfo?.username ?? null,
		runtime: params.runtime
	});
	if (!decision) return false;
	if (decision.decision === "continue_normal") return false;
	if (decision.decision === "intercept_media_only" || decision.decision === "deny") {
		if (decision.responseText) await withTelegramApiErrorLogging({
			operation: "sendMessage",
			runtime: params.runtime,
			fn: () => params.bot.api.sendMessage(params.chatId, decision.responseText, params.threadParams)
		});
		return true;
	}
	if (decision.decision === "ignore") return true;
	return false;
}
'''
    helper_addition = helper_template.replace("__MARKER__", json.dumps(marker)).replace(
        "__MODULE_URL__", json.dumps(module_url)
    )
    handoff_addition = '''			if (await applyTelegramMediaGateDecision({
				bot,
				runtime,
				chatId: event.chatId,
				senderId: event.senderId,
				text: event.msg.text ?? event.msg.caption ?? "",
				threadParams: buildTelegramThreadParams(resolveTelegramThreadSpec({
					isGroup: event.isGroup,
					isForum: event.isForum,
					messageThreadId: event.messageThreadId
				}))
			})) return;
'''
    try:
        text = original.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise IntegrityError("target bundle is not UTF-8") from exc
    patched = text.replace(helper_anchor, helper_anchor + helper_addition, 1)
    patched = patched.replace(handoff_anchor, handoff_addition + handoff_anchor, 1)
    if patched == text or marker not in patched or module_url not in patched:
        raise IntegrityError("deterministic patch did not produce the required marker and import")
    return patched.encode("utf-8")


def prepare_patch_result(
    manifest: dict[str, Any],
    current: bytes,
    original_hash: str,
    patched_hash: str,
) -> tuple[bytes, bool]:
    verify_anchors(manifest, current)
    current_hash = sha256_bytes(current)
    marker = manifest["patch"]["marker"].encode()
    if current_hash == patched_hash:
        if current.count(marker) != 1:
            raise IntegrityError("patched hash matched but patch marker count was not one")
        return current, False
    if current_hash != original_hash:
        raise IntegrityError(f"unknown target bundle SHA-256: {current_hash}")
    patched = render_patched_bytes(manifest, current)
    verify_anchors(manifest, patched)
    final_hash = sha256_bytes(patched)
    if final_hash != patched_hash:
        raise IntegrityError(
            f"patched-result SHA-256 mismatch: expected {patched_hash}, got {final_hash}"
        )
    return patched, True
