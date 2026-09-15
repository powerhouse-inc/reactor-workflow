#!/usr/bin/env bash
# One command for the demo's reactor: install this workspace's unpublished
# pieces, then start Vetra with the environment the demo needs.
#
#   ./demo-umh/start.sh
#
# The piece installation has to happen on every start, not once. It writes
# packages/workflow/dist/pieces/index.mjs, and both `pnpm build` and the
# workflow package's own test suite regenerate that file from the tracked
# manifest — dropping the demo's pieces. When that happens the reactor loads
# one package piece instead of three, the workflows' block types resolve to
# nothing, and no trigger registers: a silent and complete stop.
set -euo pipefail
cd "$(dirname "$0")/.."

node demo-umh/scripts/install-pieces.mjs

# Drive URLs for Connect's sidebar. `ph vetra` ignores the configured
# defaultDrives (powerhouse-inc/powerhouse#3023), so they are passed here; the
# seed prints the exact flag for drives that already exist under another slug.
DRIVES="${DEMO_DEFAULT_DRIVES:-http://localhost:4001/d/pl-dashboard,http://localhost:4001/d/workflows}"

# PUBLIC_URL, not PH_PUBLIC_URL: reactor-api's resolvePublicOrigin reads
# PUBLIC_URL (or RENDER_EXTERNAL_URL), and otherwise falls back to localhost.
# It is the origin the paperless piece registers as its webhook target, and
# paperless posts from inside a container, where localhost is itself.
#
# (Comments do not go inside the `env` invocation below: a `#` in the middle of
# a backslash-continued command ends it, and `env` with no command simply
# prints the environment — which is exactly how this script first "ran".)
cd packages/workflow
exec env \
  PH_REGISTRY_PACKAGES=umh-production-ledger \
  UMH_POLLER_ENABLED=false \
  WORKFLOW_EGRESS_ALLOW_ADDRESSES="${WORKFLOW_EGRESS_ALLOW_ADDRESSES:-127.0.0.1/32,::1/128}" \
  PUBLIC_URL="${PUBLIC_URL:-http://host.docker.internal:4001}" \
  pnpm vetra --strictPort --default-drives-url "$DRIVES" "$@"
