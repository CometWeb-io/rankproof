#!/bin/sh
# `rankproof api [--port N]` starts the HTTP API on all interfaces of the
# container (publish it explicitly); anything else goes to the CLI.
set -e
if [ "$1" = "api" ]; then
  shift
  export RANKPROOF_MODE=api
  if [ -z "$RANKPROOF_API_TOKEN" ]; then
    echo "RankProof: RANKPROOF_API_TOKEN is not set; the API will accept unauthenticated requests." >&2
  fi
  exec node /app/scripts/serve-api.mjs --host 0.0.0.0 --port "${PORT:-8787}" "$@"
fi
exec node /app/bin/rankproof.mjs "$@"
