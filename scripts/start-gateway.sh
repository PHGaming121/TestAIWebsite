#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# start-gateway.sh — launch the OpenClaw Gateway (foreground)
# ---------------------------------------------------------------------------
# Configuration is read from $OPENCLAW_STATE_DIR/openclaw.json (JSON5).
# Secrets are read from the environment, never from the config file.
#
# Usage:
#   ./scripts/start-gateway.sh              # normal start
#   ./scripts/start-gateway.sh --force      # kill any listener on the port first
#
# On first run this script generates a random gateway token and stores it in
#   $OPENCLAW_STATE_DIR/.env   (mode 600, git-ignored)
# so the Gateway has an auth secret without one ever being committed.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Prefer the pinned toolchain (Node 24.16+/26.1+ required) when present.
TOOLCHAIN_DIR="${OPENCLAW_TOOLCHAIN_DIR:-$REPO_ROOT/.toolchain}"
if [[ -x "$TOOLCHAIN_DIR/bin/node" ]]; then
  export PATH="$TOOLCHAIN_DIR/bin:$PATH"
fi

# State directory holds config, auth profiles, sessions and logs.
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
export OPENCLAW_HOME="${OPENCLAW_HOME:-$OPENCLAW_STATE_DIR}"
mkdir -p "$OPENCLAW_STATE_DIR"

# --- Ensure a gateway token exists (generated once, never committed) -------
ENV_FILE="$OPENCLAW_STATE_DIR/.env"
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  if [[ -f "$ENV_FILE" ]] && grep -q '^OPENCLAW_GATEWAY_TOKEN=' "$ENV_FILE"; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
  else
    OPENCLAW_GATEWAY_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf 'OPENCLAW_GATEWAY_TOKEN=%s\n' "$OPENCLAW_GATEWAY_TOKEN" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "Generated a new gateway token at $ENV_FILE (mode 600)."
  fi
fi
export OPENCLAW_GATEWAY_TOKEN

# --- Sanity checks --------------------------------------------------------
command -v openclaw >/dev/null 2>&1 || {
  echo "error: 'openclaw' not on PATH. Install with: npm i -g openclaw@latest" >&2
  exit 1
}

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [[ "$NODE_MAJOR" -eq 24 && "$NODE_MINOR" -lt 16 ]]; then
  echo "error: OpenClaw needs Node >=24.16.0 or >=26.1.0 (found $(node -v))." >&2
  exit 1
fi

echo "OpenClaw  : $(openclaw --version)"
echo "Node      : $(node -v)"
echo "State dir : $OPENCLAW_STATE_DIR"
echo "Config    : $OPENCLAW_STATE_DIR/openclaw.json"

# Validate before booting; the Gateway refuses to start on an invalid config.
openclaw config validate --json | tee /tmp/openclaw-config-validate.json
echo

exec openclaw gateway run "$@"
