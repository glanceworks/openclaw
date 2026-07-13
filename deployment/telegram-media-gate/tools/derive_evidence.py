#!/usr/bin/env python3
"""Derive controlled-copy bundle evidence without changing the deployment manifest."""
from __future__ import annotations
import argparse, json, pathlib, sys
from integrity import (
    IntegrityError,
    load_manifest,
    prepare_patch_result,
    render_patched_bytes,
    sha256_bytes,
)

def snapshot(root: pathlib.Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise IntegrityError(f"controlled dist contains a symlink: {path}")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = sha256_bytes(path.read_bytes())
    return result

def explicit_target(root: pathlib.Path, relative: str) -> pathlib.Path:
    rel = pathlib.PurePosixPath(relative)
    if rel.is_absolute() or ".." in rel.parts or not rel.parts:
        raise IntegrityError("target relative path is unsafe")
    target = root.joinpath(*rel.parts)
    if target.is_symlink() or not target.is_file():
        raise IntegrityError("explicit controlled target is missing or unsafe")
    resolved = target.resolve(strict=True)
    if root not in resolved.parents:
        raise IntegrityError("explicit controlled target escapes dist root")
    return resolved

def main() -> int:
    parser = argparse.ArgumentParser(description="derive controlled Telegram bundle evidence")
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--dist-root", type=pathlib.Path, required=True)
    parser.add_argument("--target-relative-path", required=True)
    args = parser.parse_args()
    try:
        root = args.dist_root.resolve(strict=True)
        if root == pathlib.Path("/app/dist"):
            raise IntegrityError("evidence derivation refuses the production /app/dist path")
        manifest = load_manifest(args.manifest)
        target = explicit_target(root, args.target_relative_path)
        before = snapshot(root)
        original = target.read_bytes()
        anchor_counts: dict[str, int] = {}
        for anchor in manifest["bundle"]["structural_anchors"]:
            count = original.count(anchor["text"].encode("utf-8"))
            anchor_counts[anchor["name"]] = count
            if count != 1:
                raise IntegrityError(
                    f"evidence anchor {anchor['name']!r} must occur exactly once, got {count}"
                )
            anchor["expected_count"] = count
        original_hash = sha256_bytes(original)
        derived = render_patched_bytes(manifest, original)
        patched_hash = sha256_bytes(derived)
        first, first_changed = prepare_patch_result(
            manifest, original, original_hash, patched_hash
        )
        if not first_changed or first != derived:
            raise IntegrityError("production patch state disagrees with evidence derivation")
        target.write_bytes(first)
        after = snapshot(root)
        changed_files = sorted(
            name for name in set(before) | set(after) if before.get(name) != after.get(name)
        )
        if changed_files != [args.target_relative_path]:
            raise IntegrityError(f"expected exactly one changed file, got {changed_files!r}")
        second, second_changed = prepare_patch_result(
            manifest, target.read_bytes(), original_hash, patched_hash
        )
        idempotent = not second_changed and second == target.read_bytes()
        if not idempotent:
            raise IntegrityError("second production patch pass was not idempotent")
        print(json.dumps({
            "mode": "controlled-evidence-derivation",
            "original_sha256": original_hash,
            "patched_sha256": patched_hash,
            "changed_files": changed_files,
            "anchor_counts": anchor_counts,
            "idempotent": idempotent,
        }, indent=2, sort_keys=True))
        return 0
    except (IntegrityError, OSError, KeyError, TypeError) as exc:
        print(f"evidence derivation failed: {exc}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
