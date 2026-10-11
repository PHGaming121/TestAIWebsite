#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify.sh — mechanical verification of an OpenClaw deployment
# ---------------------------------------------------------------------------
# Runs every check in the published checklist against the LIVE installation and
# writes both a human-readable report and a machine-readable status file.
#
#   ./scripts/verify.sh                       # local install (~/.openclaw)
#   OPENCLAW_STATE_DIR=/srv/oc ./scripts/verify.sh
#   ./scripts/verify.sh --json                # print JSON to stdout only
#
# Exit code: 0 when all *required* checks pass, 1 otherwise.
# Checks that need a provider credential are reported as PENDING, not FAIL —
# they are impossible to satisfy without a key the operator must supply.
# ---------------------------------------------------------------------------
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
export OPENCLAW_HOME="${OPENCLAW_HOME:-$OPENCLAW_STATE_DIR}"

GATEWAY_PORT="${GATEWAY_PORT:-$(
  [[ -f "$OPENCLAW_STATE_DIR/openclaw.json" ]] \
    && grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$OPENCLAW_STATE_DIR/openclaw.json" \
    | head -1 | grep -oE '[0-9]+$'
)}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
BASE="http://127.0.0.1:${GATEWAY_PORT}"

OUT_DIR="$REPO_ROOT/reports"
JSON_OUT="$OUT_DIR/status.json"
MD_OUT="$OUT_DIR/verification-report.md"
JSON_ONLY=0
[[ "${1:-}" == "--json" ]] && JSON_ONLY=1

mkdir -p "$OUT_DIR"

# name | status(PASS/FAIL/PENDING/SKIP) | detail
ROWS=()
FAILED=0
PENDING=0

record() {
  local name="$1" status="$2" detail="$3"
  ROWS+=("${name}|${status}|${detail}")
  case "$status" in
    FAIL)    FAILED=$((FAILED + 1)) ;;
    PENDING) PENDING=$((PENDING + 1)) ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# --- 1. Node runtime -------------------------------------------------------
if have node; then
  NODE_RAW="$(node -v)"
  NM="${NODE_RAW#v}"; MAJ="${NM%%.*}"; MIN="$(node -p 'process.versions.node.split(".")[1]')"
  if { [[ "$MAJ" -eq 24 && "$MIN" -ge 16 ]]; } || [[ "$MAJ" -ge 26 ]]; then
    record "Node runtime supported" PASS "node $NODE_RAW (requires >=24.16.0 or >=26.1.0)"
  else
    record "Node runtime supported" FAIL "node $NODE_RAW is unsupported"
  fi
else
  record "Node runtime supported" FAIL "node not found on PATH"
fi

# --- 2. OpenClaw CLI -------------------------------------------------------
if have openclaw; then
  OC_VERSION="$(openclaw --version 2>/dev/null | head -1)"
  if [[ -n "$OC_VERSION" ]]; then
    record "OpenClaw CLI installed" PASS "${OC_VERSION#OpenClaw }"
  else
    record "OpenClaw CLI installed" FAIL "openclaw found but did not report a version"
  fi
else
  OC_VERSION=""
  record "OpenClaw CLI installed" FAIL "openclaw not on PATH"
fi

# --- 3. Config present and schema-valid -----------------------------------
if [[ -f "$OPENCLAW_STATE_DIR/openclaw.json" ]]; then
  VALID_JSON="$(openclaw config validate --json 2>/dev/null)"
  if grep -q '"valid":true' <<<"$VALID_JSON"; then
    if grep -q '"warnings":\[\]' <<<"$VALID_JSON"; then
      record "Config valid against schema" PASS "valid:true, no warnings"
    else
      record "Config valid against schema" PASS "valid:true (with warnings: $VALID_JSON)"
    fi
  else
    record "Config valid against schema" FAIL "validation failed: ${VALID_JSON:-no output}"
  fi
else
  record "Config valid against schema" FAIL "no config at $OPENCLAW_STATE_DIR/openclaw.json"
fi

# --- 4. Model routing ------------------------------------------------------
MODELS_TXT="$(openclaw models status 2>/dev/null)"
if grep -qE '^Default[[:space:]]*:' <<<"$MODELS_TXT"; then
  DEFAULT_MODEL="$(grep -E '^Default[[:space:]]*:' <<<"$MODELS_TXT" | sed 's/.*:[[:space:]]*//' | tr -d '\r')"
  FB_LINE="$(grep -E '^Fallbacks' <<<"$MODELS_TXT" | sed 's/.*:[[:space:]]*//')"
  FB_COUNT=0
  [[ -n "$FB_LINE" && "$FB_LINE" != "-" ]] && FB_COUNT="$(tr ',' '\n' <<<"$FB_LINE" | grep -c '[^[:space:]]')"
  if [[ -n "$DEFAULT_MODEL" && "$DEFAULT_MODEL" != "-" && "$FB_COUNT" -ge 1 ]]; then
    record "Model routing configured" PASS "primary=${DEFAULT_MODEL}; fallbacks=${FB_COUNT}"
  else
    record "Model routing configured" FAIL "primary='${DEFAULT_MODEL:-none}' fallbacks=$FB_COUNT"
  fi
else
  record "Model routing configured" FAIL "could not read 'openclaw models status'"
fi

# --- 5. Token-reduction plugin --------------------------------------------
PLUGINS_TXT="$(openclaw plugins list 2>/dev/null)"
if grep -q 'tokenjuice' <<<"$PLUGINS_TXT"; then
  if grep -E 'tokenjuice.*enabled' <<<"$PLUGINS_TXT" >/dev/null 2>&1 \
     || grep -A4 'tokenjuice' <<<"$PLUGINS_TXT" | grep -q 'enabled'; then
    record "Token-reduction plugin enabled" PASS "tokenjuice enabled"
  else
    record "Token-reduction plugin enabled" FAIL "tokenjuice present but not enabled"
  fi
else
  record "Token-reduction plugin enabled" FAIL "tokenjuice not installed (openclaw plugins install @openclaw/tokenjuice)"
fi

# --- 6. Gateway health -----------------------------------------------------
HEALTH="$(curl -s -m 10 "$BASE/health" 2>/dev/null)"
if grep -q '"ok":true' <<<"$HEALTH"; then
  record "Gateway responding" PASS "GET $BASE/health -> $HEALTH"
else
  record "Gateway responding" FAIL "GET $BASE/health -> ${HEALTH:-no response}"
fi

# --- 7. Control UI served --------------------------------------------------
UI_CODE="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE/" 2>/dev/null)"
UI_CT="$(curl -s -o /dev/null -m 10 -w '%{content_type}' "$BASE/" 2>/dev/null)"
if [[ "$UI_CODE" == "200" && "$UI_CT" == text/html* ]]; then
  record "Control UI served" PASS "HTTP 200, ${UI_CT}"
else
  record "Control UI served" FAIL "HTTP ${UI_CODE:-?}, content-type ${UI_CT:-?}"
fi

# --- 8. Auth enforced ------------------------------------------------------
# Config is JSON5, so keys may be unquoted (mode: "token"). The pattern below
# tolerates either form and matches only the gateway.auth enum, so that
# gateway.mode ("local") can never be mistaken for an auth mode.
AUTH_MODE="$(grep -oE 'mode[[:space:]]*:[[:space:]]*"(token|password|trusted-proxy|none)"' \
  "$OPENCLAW_STATE_DIR/openclaw.json" 2>/dev/null \
  | head -1 | grep -oE '(token|password|trusted-proxy|none)')"
AUTH_RL="$(grep -c 'rateLimit' "$OPENCLAW_STATE_DIR/openclaw.json" 2>/dev/null)"
if [[ -n "$AUTH_MODE" && "$AUTH_MODE" != "none" ]]; then
  if [[ "${AUTH_RL:-0}" -ge 1 ]]; then
    record "Gateway auth enforced" PASS "mode=${AUTH_MODE}; auth rate limiting configured"
  else
    record "Gateway auth enforced" PASS "mode=${AUTH_MODE} (rate limiting not configured)"
  fi
else
  record "Gateway auth enforced" FAIL "gateway.auth.mode is '${AUTH_MODE:-unset}' — unprotected"
fi

# --- 9. Provider credential (operator-supplied) ---------------------------
CRED_HINT="none"
if [[ -n "${OPENROUTER_API_KEY:-}${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${GOOGLE_API_KEY:-}${XAI_API_KEY:-}" ]]; then
  CRED_HINT="environment"
elif grep -qE 'Providers w/ OAuth/tokens \(([1-9][0-9]*)\)' <<<"$MODELS_TXT"; then
  CRED_HINT="auth profile"
fi

if [[ "$CRED_HINT" != "none" ]]; then
  record "Provider credential present" PASS "found via ${CRED_HINT}"
  CREDENTIALS_AVAILABLE=1
else
  record "Provider credential present" PENDING "no provider key in env or auth store — set OPENROUTER_API_KEY"
  CREDENTIALS_AVAILABLE=0
fi

# --- 10. End-to-end model reply (only with a credential) ------------------
if [[ "$CREDENTIALS_AVAILABLE" -eq 1 ]]; then
  REPLY="$(timeout 120 openclaw agent --local --message "Reply with exactly: pong" 2>&1 | tail -5)"
  if grep -qi 'pong' <<<"$REPLY"; then
    record "End-to-end model reply" PASS "model answered: $(tr -d '\n' <<<"$REPLY" | cut -c1-80)"
  else
    record "End-to-end model reply" FAIL "no usable reply: $(tr -d '\n' <<<"$REPLY" | cut -c1-160)"
  fi
else
  record "End-to-end model reply" PENDING "skipped — requires a provider credential (check 9)"
fi

# --- Emit ------------------------------------------------------------------
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TOTAL=${#ROWS[@]}
PASSED=$((TOTAL - FAILED - PENDING))

{
  printf '{\n'
  printf '  "generatedAt": "%s",\n' "$TS"
  printf '  "openclaw": "%s",\n' "$(sed 's/^OpenClaw //' <<<"${OC_VERSION:-unknown}")"
  printf '  "node": "%s",\n' "${NODE_RAW:-unknown}"
  printf '  "gatewayPort": %s,\n' "$GATEWAY_PORT"
  printf '  "summary": { "total": %d, "passed": %d, "failed": %d, "pending": %d },\n' "$TOTAL" "$PASSED" "$FAILED" "$PENDING"
  printf '  "checks": [\n'
  for i in "${!ROWS[@]}"; do
    IFS='|' read -r n s d <<<"${ROWS[$i]}"
    sep=","; [[ "$i" -eq $((TOTAL - 1)) ]] && sep=""
    d_esc="${d//\\/\\\\}"; d_esc="${d_esc//\"/\\\"}"
    printf '    { "name": "%s", "status": "%s", "detail": "%s" }%s\n' "$n" "$s" "$d_esc" "$sep"
  done
  printf '  ]\n}\n'
} > "$JSON_OUT"

if [[ "$JSON_ONLY" -eq 1 ]]; then
  cat "$JSON_OUT"
else
  {
    echo "# OpenClaw verification report"
    echo
    echo "Generated: \`$TS\`  "
    echo "Host runtime: \`${NODE_RAW:-unknown}\`  "
    echo "OpenClaw: \`${OC_VERSION:-unknown}\`  "
    echo "State dir: \`$OPENCLAW_STATE_DIR\`"
    echo
    echo "**$PASSED/$TOTAL passed · $FAILED failed · $PENDING pending (need an operator key)**"
    echo
    echo "| Check | Status | Detail |"
    echo "| --- | --- | --- |"
    for r in "${ROWS[@]}"; do
      IFS='|' read -r n s d <<<"$r"
      echo "| $n | **$s** | $d |"
    done
    echo
    if [[ "$PENDING" -gt 0 ]]; then
      echo "> Checks marked PENDING require a provider credential that is not present in this"
      echo "> environment. Supply one, then re-run \`./scripts/verify.sh\` to complete them."
      echo
    fi
    echo "Raw machine-readable output: \`reports/status.json\`"
  } > "$MD_OUT"

  cat "$MD_OUT"
  echo
  echo "Written: ${MD_OUT#$REPO_ROOT/}"
  echo "Written: ${JSON_OUT#$REPO_ROOT/}"
fi

[[ "$FAILED" -eq 0 ]] && exit 0 || exit 1
