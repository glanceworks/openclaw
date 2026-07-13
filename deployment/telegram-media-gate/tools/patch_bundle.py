#!/usr/bin/env python3
import argparse, pathlib, sys
from integrity import IntegrityError, ensure_ready, load_manifest, prepare_patch_result, resolve_target, sha256_bytes, verify_version
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
        result, changed = prepare_patch_result(
            manifest,
            selected.read_bytes(),
            manifest["bundle"]["original_sha256"],
            manifest["bundle"]["patched_sha256"],
        )
        if not changed:
            print(f"already patched: {selected}")
            return 0
        selected.write_bytes(result)
        if sha256_bytes(selected.read_bytes()) != manifest["bundle"]["patched_sha256"]:
            raise IntegrityError("post-write patched SHA-256 verification failed")
        print(f"patched deterministically: {selected}")
        return 0
    except (IntegrityError, OSError) as exc:
        print(f"bundle patch failed: {exc}", file=sys.stderr)
        return 1
if __name__ == "__main__":
    raise SystemExit(main())
