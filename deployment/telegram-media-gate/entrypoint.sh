#!/bin/sh
set -eu

DEPLOYMENT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 "$DEPLOYMENT_DIR/tools/verify_startup.py"   --manifest "$DEPLOYMENT_DIR/deployment-manifest.json"   --app-root /app   --dist-root /app/dist

exec docker-entrypoint.sh "$@"
