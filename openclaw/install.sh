#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# install.sh — idempotent OpenClaw setup
# ---------------------------------------------------------------------------
# Does, in order:
#   1. verify the local Node runtime is supported (>=24.16.0 or >=26.1.0)
#   2. install the OpenClaw CLI globally if it is missing
#   3. install the config template and validate it against OpenClaw's schema
#   4. install the official token-reduction plugin
#
# Safe to re-run. Adds nothing to your system that it does not report.
#
# Usage:
#   ./openclaw/install.sh              # normal
#   ./openclaw/install.sh --dry-run    # print what would happen
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [[ $DRY_RUN -eq 1 ]]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }

# --- 1. Node runtime -------------------------------------------------------
say "Checking Node runtime"
command -v node >/dev/null 2>&1 || die "node not found. Install Node 24.16+ or 26.1+ (https://nodejs.org)."

NODE_RAW="$(node -v)"; NODE_MAJOR="${NODE_RAW#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
echo "    node $NODE_RAW"

if [[ "$NODE_MAJOR" -eq 24 && "$NODE_MINOR" -lt 16 ]]; then
  die "Node $NODE_RAW is too old. OpenClaw requires >=24.16.0 or >=26.1.0. Node 26 recommended."
elif [[ "$NODE_MAJOR" -lt 24 ]]; then
  die "Node $NODE_RAW is too old. OpenClaw requires >=24.16.0 or >=26.1.0. Node 26 recommended."
elif [[ "$NODE_MAJOR" -eq 25 ]]; then
  warn "Node 25 is not a supported line. Use 24.16+, 26.1+, or an LTS release."
fi
echo "    runtime OK"

# --- 2. OpenClaw CLI -------------------------------------------------------
say "Checking OpenClaw CLI"
if command -v openclaw >/dev/null 2>&1; then
  echo "    already installed: $(openclaw --version)"
else
  run npm install -g openclaw@latest
  command -v openclaw >/dev/null 2>&1 || [[ $DRY_RUN -eq 1 ]] \
    || die "openclaw still not on PATH. Fix your npm global prefix, then re-run."
fi

# --- 3. Config ------------------------------------------------------------
say "Installing configuration"
run mkdir -p "$STATE_DIR"
if [[ -f "$STATE_DIR/openclaw.json" ]]; then
  BACKUP="$STATE_DIR/openclaw.json.pre-install.$(date -u +%Y%m%dT%H%M%SZ)"
  warn "existing config found — backing up to $BACKUP"
  run cp "$STATE_DIR/openclaw.json" "$BACKUP"
fi
run cp "$REPO_ROOT/openclaw/openclaw.json5" "$STATE_DIR/openclaw.json"

say "Validating configuration against the OpenClaw schema"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "    [dry-run] openclaw config validate"
else
  OPENCLAW_STATE_DIR="$STATE_DIR" openclaw config validate --json | tee /tmp/openclaw-validate.json
  grep -q '"valid":true' /tmp/openclaw-validate.json \
    || die "Config failed validation. Run 'openclaw doctor' for the exact violations."
fi

# --- 4. Token-reduction plugin -------------------------------------------
say "Installing the official token-reduction plugin (tokenjuice)"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "    [dry-run] openclaw plugins install @openclaw/tokenjuice"
elif OPENCLAW_STATE_DIR="$STATE_DIR" openclaw plugins list 2>/dev/null | grep -q 'tokenjuice'; then
  echo "    already present"
else
  OPENCLAW_STATE_DIR="$STATE_DIR" openclaw plugins install @openclaw/tokenjuice
fi

# --- Done -----------------------------------------------------------------
cat <<EOF

$(say "Setup complete")

  Next steps
  ----------
  1. Provide credentials (at minimum OPENROUTER_API_KEY):
       cp openclaw/.env.example openclaw/.env && edit it
       set -a; source openclaw/.env; set +a

  2. Start the Gateway:
       ./scripts/start-gateway.sh

  3. Verify everything:
       ./scripts/verify.sh

  State dir : $STATE_DIR
  Config    : $STATE_DIR/openclaw.json
EOF
