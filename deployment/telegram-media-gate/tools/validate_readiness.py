#!/usr/bin/env python3
import argparse, pathlib, sys
from integrity import IntegrityError, ensure_ready, load_manifest, verify_runtime_files
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--runtime-root", type=pathlib.Path, required=True)
    parser.add_argument("--source-layout", action="store_true")
    args = parser.parse_args()
    try:
        manifest = load_manifest(args.manifest)
        ensure_ready(manifest)
        verify_runtime_files(manifest, args.runtime_root, use_image_paths=not args.source_layout)
    except IntegrityError as exc:
        print(f"readiness validation failed: {exc}", file=sys.stderr)
        return 1
    print("telegram media-gate deployment manifest is ready")
    return 0
if __name__ == "__main__":
    raise SystemExit(main())
