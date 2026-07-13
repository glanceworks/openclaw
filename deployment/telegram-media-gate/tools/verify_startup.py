#!/usr/bin/env python3
import argparse, pathlib, sys
from integrity import IntegrityError, ensure_ready, load_manifest, resolve_target, sha256_bytes, verify_anchors, verify_version
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--app-root", type=pathlib.Path, required=True)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--dist-root", type=pathlib.Path)
    target.add_argument("--target-file", type=pathlib.Path)
    args = parser.parse_args()
    try:
        manifest = load_manifest(args.manifest)
        ensure_ready(manifest)
        verify_version(manifest, args.app_root)
        selected = resolve_target(manifest, args.dist_root, args.target_file)
        current = selected.read_bytes()
        verify_anchors(manifest, current)
        current_hash = sha256_bytes(current)
        patched_hash = manifest["bundle"]["patched_sha256"]
        original_hash = manifest["bundle"]["original_sha256"]
        if current_hash == original_hash:
            raise IntegrityError("image contains the exact original bundle and was not patched at build time")
        if current_hash != patched_hash:
            raise IntegrityError(f"unknown target bundle SHA-256: {current_hash}")
        if current.count(manifest["patch"]["marker"].encode()) != 1:
            raise IntegrityError("patched bundle marker count is not one")
        print(f"startup verification passed: {selected}")
        return 0
    except (IntegrityError, OSError) as exc:
        print(f"startup verification failed: {exc}", file=sys.stderr)
        return 1
if __name__ == "__main__":
    raise SystemExit(main())
