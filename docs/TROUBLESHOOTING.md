# Troubleshooting guide

Symptom-first. Start with the diagnosis command, then the fix.

**First line of defence for any problem:**

```bash
openclaw doctor          # read-only health checks
openclaw triage          # fuller diagnosis, sanitised, excludes secrets and raw payloads
```

---

## Startup failures

### Gateway refuses to start after I edited the config

OpenClaw validates **strictly**: one unknown key, wrong type, or out-of-range value stops the
boot. The only useful signal is:

```bash
openclaw doctor              # exact schema violations
openclaw doctor --fix        # repair legacy keys; restores last-known-good if needed
openclaw config validate     # confirm before restarting
```

Only diagnostic commands work while the config is invalid: `doctor`, `logs`, `health`,
`status`. That is intentional — it prevents a bad config from becoming a half-running
Gateway.

**Find the right key instead of guessing:**

```bash
openclaw config schema | jq '.properties.gateway'          # canonical JSON Schema
openclaw config schema | jq 'paths | join(".")' | grep -i budget
```

If your version of a key differs from this repository's template, the schema is the
authority — not the template, and not any documentation, including this one.

### "Config auto-restored from backup"

If OpenClaw detects an accidental clobber — a write that drops `gateway.mode` or shrinks the
file by more than half — it refuses the write and preserves it for inspection instead:

```
openclaw.json.clobbered.2026-10-11T19-12-40-408Z
```

This is a safety feature, not an error. Inspect that file to see what the rejected writer
tried to do. It commonly fires when a tool "helpfully" normalises the config and strips all
comments, dropping the file size below the threshold.

**Note:** tooling that rewrites the config will strip JSON5 comments. Keep the annotated
template in version control as the source of truth, and treat the runtime file as generated.

### "Unsupported Node version"

The package installs; the CLI then refuses to run.

```
Node v22.22.3 is unsupported; OpenClaw requires >=24.16.0, or >=26.1.0 (Node 26 recommended).
```

```bash
nvm install 26 && nvm use 26 && nvm alias default 26
node -v && openclaw --version
```

A successful `npm install` is **not** evidence of a supported runtime — npm can finish
installing OpenClaw without running its preinstall check.

---

## Network and port problems

### Port 18789 already in use

```bash
openclaw gateway run --force              # kill the existing listener on the port
```

Or move the Gateway, and update anything that points at it:

```bash
openclaw config set gateway.port 19001
openclaw config validate && openclaw gateway restart
```

### Gateway unreachable from another machine

Check, in order — each is a distinct failure with a distinct fix:

```bash
# 1. Is it running at all?
curl -s http://127.0.0.1:18789/health

# 2. Is it bound where you think?
openclaw config get gateway.bind           # "loopback" = local only
openclaw gateway probe

# 3. Is auth rejecting you?
openclaw gateway auth-token
```

`loopback` means exactly that: reachable only from the host itself. Container and
port-proxy setups need `"custom"` with `customBindHost: "0.0.0.0"` or `"lan"`.

The Gateway logs a warning when it binds to a non-loopback address — read it as a prompt to
confirm that `gateway.auth` is configured, not as noise.

### Control UI loads but the browser will not connect

The WebSocket origin check rejected the page. Add the **full origin** — scheme and host, no
trailing path:

```bash
openclaw config set gateway.controlUi.allowedOrigins \
  '["https://your-dashboard.example.com"]'
openclaw config validate && openclaw gateway restart
```

Origins are exact matches; `https://example.com` does not cover
`https://app.example.com`. `["*"]` works and is documented as unsuitable outside tightly
controlled local testing — do not publish it.

There is also `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`. The name is
accurate. Prefer an explicit allowlist.

---

## Model problems

### Every route says "indeterminate"

No usable credential was found. The routes exist but cannot be authenticated.

```bash
openclaw models status          # shows "Providers w/ OAuth/tokens (0)"
openclaw models auth login --provider openrouter
openclaw models status          # re-check
```

Confirm the variable actually reached the process — a `${OPENROUTER_API_KEY}` left literal
in the config means substitution did not happen:

```bash
env | grep -c OPENROUTER_API_KEY     # 1 = present
grep OPENROUTER_API_KEY ~/.openclaw/openclaw.json
```

If you used `set -a; source openclaw/.env; set +a` in a shell and then started the Gateway
from a *different* shell, the variable is not there. Export it in the shell that launches
the Gateway, or write it into the service unit.

### Model not found / invalid model

Model refs are `provider/model`, and provider-side IDs change as models are retired.

```bash
openclaw models list                 # what is configured
openclaw models refresh              # refresh the hosted catalog
openclaw models set openrouter/auto  # a safe, self-routing fallback
```

### Replies are slow or degrade over a long session

Usually context growth, not the model. Check what is entering the window:

```bash
/status        # in-session: model, context usage, last-response tokens
/usage full    # append a usage + estimated-cost footer to every reply
```

Reduce it:

- Confirm tokenjuice is actually enabled — it compacts tool output, typically the largest
  contributor (see check 5 in `docs/VERIFICATION.md`).
- Lower `agents.defaults.imageMaxDimensionPx` (default 1200) if screenshots dominate.
- Lower `skills.limits.maxSkillsPromptChars` if you have many skills installed.
- Review bootstrap injection: `bootstrapMaxChars` (20000) and `bootstrapTotalMaxChars`
  (60000).

### Model calls fail and you need to know whether fallback worked

Fallback is **turn-local**: the session keeps its selected model, and a fallback answers only
the failing turn. `/status` distinguishes the selected model from the one that replied. If
every candidate fails, the error summarises each attempt with the soonest cooldown expiry.

---

## Plugin problems

### Plugin installed but does nothing

```bash
openclaw plugins list                        # is it enabled?
openclaw plugins inspect tokenjuice --runtime --json
openclaw plugins doctor                      # load errors
openclaw plugins enable tokenjuice
```

`installed` and `enabled` are different states. Installation applies to a running Gateway
without a restart, but a plugin that is installed and disabled fails silently — nothing
errors, it simply never runs. This is exactly what verification check 5 catches.

### Plugin install fails

Bare package specs install from npm. Be explicit when a name is ambiguous:

```bash
openclaw plugins install @openclaw/tokenjuice        # npm
openclaw plugins install clawhub:@openclaw/tokenjuice # ClawHub explicitly
openclaw plugins install ./path/to/plugin             # local path
```

In restricted networks where the ClawHub registry is unreachable, install from npm directly
using the package name.

### Suspected supply-chain risk

Third-party plugins receive deep agent permissions.

```bash
openclaw plugins inspect <id> --runtime --json
openclaw plugins list                    # confirm the source root
```

Prefer packages in OpenClaw's official plugin inventory, and evaluate anything else in a
throwaway environment first.

---

## Performance

### Gateway slow to start

`openclaw doctor` will usually say this outright. Cold starts on small hosts are dominated
by module compilation:

```bash
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
```

For routine restarts to stay in-process rather than handing off to a supervisor:

```bash
export OPENCLAW_NO_RESPAWN=1
```

### High memory

Check what the Gateway is holding:

```bash
openclaw gateway stability       # payload-free stability diagnostics
openclaw gateway diagnostics     # export local support diagnostics
```

Long sessions are the usual cause. Compaction and session-reset settings exist for this;
see the official session-management docs.

---

## Recovering from a bad state

```bash
openclaw doctor --fix                 # repairs legacy keys, restores last-known-good config
openclaw backup create                # snapshot config, sessions and state
openclaw backup verify
```

The Gateway keeps a trusted last-known-good config after each successful start, but it does
**not** auto-restore on failure — only `openclaw doctor --fix` does. If `openclaw.json`
remains invalid after eligible migrations, startup fails. That is deliberate: silently
running on a config you did not write is worse than not starting.

---

## Still stuck

```bash
openclaw triage      # builds a sanitised diagnosis; secrets and raw payloads excluded
openclaw doctor
openclaw logs
```

`openclaw triage` can hand its findings to a coding agent, or print the commands for you to
run yourself. Nothing leaves the machine until you choose that.
