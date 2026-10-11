# Verification guide

What `./scripts/verify.sh` checks, why each check matters, and how to complete the two that
need a credential you must supply.

```bash
./scripts/verify.sh            # human-readable report + JSON
./scripts/verify.sh --json     # machine-readable only
```

Outputs:

| File | Purpose |
| --- | --- |
| `reports/verification-report.md` | The checklist, with observed values |
| `reports/status.json` | Same data, machine-readable, for CI or dashboards |

**Exit code** is `0` when no check fails. Checks that cannot pass without an operator key
are reported `PENDING`, which does **not** fail the run — they are impossible to satisfy
without a credential, and pretending otherwise would make the report dishonest.

---

## The checks

### 1. Node runtime supported

```bash
node -v
```

**Requirement:** ≥ 24.16.0 or ≥ 26.1.0. Node 26 is recommended.

Why it matters: the npm package installs successfully on any Node, but the CLI refuses to
run on an unsupported version. A "successful install" is therefore not evidence of a working
runtime — this check is the evidence.

### 2. OpenClaw CLI installed

```bash
openclaw --version
```

**Pass:** prints a version string.

### 3. Configuration valid against the schema

```bash
openclaw config validate --json
```

**Pass:** `"valid":true` with no warnings.

Why it matters: OpenClaw validates strictly and will not boot on an unknown key or wrong
type. This is the difference between "I wrote a config" and "the Gateway accepts my config".

### 4. Model routing configured

```bash
openclaw models status
```

**Pass:** a default model is set **and** at least one fallback exists.

Why it matters: a single model with no fallback is a single point of failure. The check
fails on `primary=-` or `fallbacks=0` so a silent regression in routing is caught.

### 5. Token-reduction plugin enabled

```bash
openclaw plugins list
```

**Pass:** `tokenjuice` appears **and** is enabled.

Why it matters: installed-but-disabled is the most common plugin misconfiguration, and it
is invisible — nothing errors, the plugin simply never runs.

### 6. Gateway responding

```bash
curl -s http://127.0.0.1:18789/health
```

**Pass:** `{"ok":true,"status":"live"}`.

### 7. Control UI served

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}' http://127.0.0.1:18789/
```

**Pass:** HTTP `200` with a `text/html` content type.

### 8. Gateway auth enforced

Inspects `gateway.auth.mode` in the config **and** confirms a `rateLimit` block is present.

**Pass:** mode is `token`, `password`, or `trusted-proxy` — anything but `none`.

Why it matters: this is the check that catches the single worst misconfiguration, an
unauthenticated Gateway. `exemptLoopback: true` keeps local development convenient without
weakening remote access. The check tolerates JSON5's unquoted keys and only matches against
the auth enum, so `gateway.mode: "local"` can never be mistaken for an auth mode.

### 9. Provider credential present — *may be PENDING*

Looks for a provider key in the environment (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`) or a stored OAuth/token auth profile.

**To complete it:**

```bash
export OPENROUTER_API_KEY="…"     # then re-run verify.sh
# or, for profile-based auth:
openclaw models auth login --provider openrouter
```

### 10. End-to-end model reply — *may be PENDING*

```bash
openclaw agent --local --message "Reply with exactly: pong"
```

**Pass:** the reply contains `pong`.

Why it matters: this is the only check that proves the whole chain — credential, provider,
model ID, network, routing — actually produces a completion. Checks 1–8 can all pass while
model traffic is broken. This one cannot.

---

## Reference run

Recorded 2026-10-11 on OpenClaw 2026.10.1 / Node v26.11.1:

```
8/10 passed · 0 failed · 2 pending (need an operator key)
```

| # | Check | Result |
| --- | --- | --- |
| 1 | Node runtime supported | PASS — v26.11.1 |
| 2 | OpenClaw CLI installed | PASS — 2026.10.1 (e178c39) |
| 3 | Config valid against schema | PASS — valid:true, no warnings |
| 4 | Model routing configured | PASS — primary + 3 fallbacks |
| 5 | Token-reduction plugin enabled | PASS — tokenjuice |
| 6 | Gateway responding | PASS — `{"ok":true,"status":"live"}` |
| 7 | Control UI served | PASS — HTTP 200, text/html |
| 8 | Gateway auth enforced | PASS — mode=token, rate limiting configured |
| 9 | Provider credential present | PENDING — no key in the build environment |
| 10 | End-to-end model reply | PENDING — blocked on check 9 |

---

## Running verification in CI

Because the script exits non-zero only on genuine failures, it can gate a pipeline:

```yaml
- run: ./openclaw/install.sh
- run: ./scripts/start-gateway.sh & sleep 30
- run: ./scripts/verify.sh
```

Add `--json` and assert on `summary.failed == 0` if you want to tolerate pending checks
explicitly. Store the provider key as a CI secret and expose it only to the step that
performs the model round-trip.
