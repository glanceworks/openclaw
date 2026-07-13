#!/usr/bin/env python3
import argparse, pathlib, sys
from integrity import IntegrityError, load_manifest, verify_base_image_reference

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--supplied-reference", required=True)
    args = parser.parse_args()
    try:
        verify_base_image_reference(load_manifest(args.manifest), args.supplied_reference)
    except IntegrityError as exc:
        print(f"base-image validation failed: {exc}", file=sys.stderr)
        return 1
    print("OPENCLAW_BASE_IMAGE exactly matches the reviewed deployment manifest")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
