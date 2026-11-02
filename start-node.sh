#!/usr/bin/env bash
# Start a local AD4M node for this demo, with the normal settings of the release.
#
#   ./start-node.sh init    create .node/ (the node's data and its admin credential)
#   ./start-node.sh run     start the executor in the foreground (Ctrl-C stops it);
#                           more arguments go to `ad4m-executor run`
#
# Environment:
#   AD4M_EXECUTOR  path to the ad4m-executor binary (default: ad4m-executor on PATH)
#   AD4M_PORT      API port (default 12100; Holochain uses the next two ports)
#   NODE_DIR       where the node lives (default: .node next to this script)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_DIR="${NODE_DIR:-$HERE/.node}"
PORT="${AD4M_PORT:-12100}"
EXECUTOR="${AD4M_EXECUTOR:-ad4m-executor}"

case "${1:-}" in
init)
    if [ -e "$NODE_DIR" ]; then
        echo "$NODE_DIR already exists; remove it to start over" >&2
        exit 1
    fi
    # A half-made node is useless and blocks the next init: remove it on failure.
    trap 'rm -rf "$NODE_DIR"; echo "init failed; removed $NODE_DIR" >&2' ERR
    mkdir -p "$NODE_DIR"
    "$EXECUTOR" init --data-path "$NODE_DIR/data"
    # Whoever holds this credential controls the node. The demo scripts read it.
    (umask 077 && head -c 32 /dev/urandom | base64 > "$NODE_DIR/admin-credential")
    trap - ERR
    echo "Node ready in $NODE_DIR. Start it with: ./start-node.sh run"
    ;;
run)
    shift
    AD4M_ADMIN_CREDENTIAL_FILE="$NODE_DIR/admin-credential" exec "$EXECUTOR" run \
        --app-data-path "$NODE_DIR/data" \
        --port "$PORT" \
        --hc-admin-port "$((PORT + 1))" \
        --hc-app-port "$((PORT + 2))" \
        --run-dapp-server false \
        --enable-mcp false \
        "$@"
    ;;
*)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
