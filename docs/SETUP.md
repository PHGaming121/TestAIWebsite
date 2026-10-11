# Setup guide

Complete, reproducible setup for OpenClaw with the configuration in this repository.

**Time:** ~10 minutes, excluding provider signup.

---

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js ≥ 24.16.0 **or** ≥ 26.1.0 | Node 26 is recommended. Node 25 and anything below 24.16 are rejected at startup. |
| A provider credential | OpenRouter is the fastest single-key path to many models. |
| ~2 GB free disk | The OpenClaw npm package plus its extraction cache is large. |

```bash
node -v     # must satisfy the range above
```

If you need to install or switch Node:

```bash
nvm install 26 && nvm use 26 && nvm alias default 26
```

> **Note on installing Node.** Prefer whatever your platform provides — a distro package,
> the official installer from nodejs.org, or nvm. If you are in a restricted environment
> where nodejs.org is unreachable (some CI sandboxes, offline hosts), Node binaries are also
> published to npm and can be pinned explicitly:
>
> ```bash
> npm install node-linux-x64@26.11.1 --prefix "$HOME/.toolchain"
> export PATH="$HOME/.toolchain/node_modules/node-linux-x64/bin:$PATH"
> ```
>
> Pin an explicit version. The package's `latest` dist-tag still points at long-obsolete
> Node releases, so an unpinned install will give you a version OpenClaw refuses to run.

---

## 2. Install OpenClaw and validate the configuration

```bash
./openclaw/install.sh
```

The installer is idempotent and does four things:

1. **Checks the Node runtime** and refuses to continue on an unsupported version.
2. **Installs the OpenClaw CLI** if `openclaw` is not already on `PATH`.
3. **Installs and validates the config** — copying `openclaw/openclaw.json5` to
   `$OPENCLAW_STATE_DIR/openclaw.json` (default `~/.openclaw/openclaw.json`), backing up any
   existing config first, then running `openclaw config validate`.
4. **Installs `@openclaw/tokenjuice`**, the official token-compaction plugin.

Preview without changing anything:

```bash
./openclaw/install.sh --dry-run
```

### Why validation matters

OpenClaw validates its config **strictly**. One unknown key, one wrong type, one
out-of-range value, and the Gateway refuses to start — only diagnostic commands
(`doctor`, `logs`, `health`, `status`) remain available. `openclaw config validate` catches
that before you try to boot.

---

## 3. Configure secrets

No credential ever belongs in the config file. The template references environment
variables, which OpenClaw substitutes when it loads the config:

```json5
gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } }
```

So a config file that leaks leaks nothing.

```bash
cp openclaw/.env.example openclaw/.env
"$EDITOR" openclaw/.env
set -a; source openclaw/.env; set +a
```

At minimum set one provider key. For the routing shipped in the template:

```bash
export OPENROUTER_API_KEY="…"
```

`scripts/start-gateway.sh` generates `OPENCLAW_GATEWAY_TOKEN` for you on first run and
stores it in `$OPENCLAW_STATE_DIR/.env` with mode `600` — you never have to invent one.

**Verify substitution worked:**

```bash
openclaw models status        # provider rows should stop saying "indeterminate"
```

If a variable is missing, OpenClaw leaves the literal `${VAR}` in place and logs a warning
rather than silently starting with a broken value.

---

## 4. Start the Gateway

```bash
./scripts/start-gateway.sh
```

It validates the config first, then launches the Gateway in the foreground:

```
[gateway] http server listening (… on port 18789)
[gateway] ready
```

- **Control UI:** <http://127.0.0.1:18789/>
- **Health probe:** <http://127.0.0.1:18789/health> → `{"ok":true,"status":"live"}`

Useful flags:

```bash
./scripts/start-gateway.sh --force     # reclaim the port from a stale listener
openclaw gateway run --port 19001      # different port
```

### Keep it running

```bash
openclaw gateway install      # systemd user unit / launchd agent / Windows scheduled task
openclaw gateway status
openclaw gateway restart
openclaw logs
```

---

## 5. Connect a model provider

### Option A — OpenRouter (one key, many models)

```bash
openclaw onboard --auth-choice openrouter-oauth   # OAuth, stores the key locally
# or simply export OPENROUTER_API_KEY and skip onboarding
openclaw models set openrouter/anthropic/claude-sonnet-4-6
```

### Option B — a direct provider

```bash
openclaw models auth login --provider anthropic
openclaw models set anthropic/claude-opus-4-6
```

### Option C — free tier

OpenClaw can find and validate zero-cost models for you:

```bash
openclaw models scan --no-probe --json     # list free candidates (no key needed)
openclaw models scan --set-default --yes   # probe for tool/image support, promote the best
```

Free models carry rate limits and variable quality; keep a paid entry in
`agents.defaults.model.fallbacks` for anything you depend on.

---

## 6. Model routing and failover

Configured in `openclaw/openclaw.json5`:

```json5
agents: {
  defaults: {
    model: {
      primary: "openrouter/anthropic/claude-sonnet-4-6",
      fallbacks: [
        "openrouter/auto",
        "openrouter/deepseek/deepseek-v4-pro",
        "openrouter/meta-llama/llama-3.3-70b-instruct",
      ],
    },
    modelPolicy: { allow: ["openrouter/*"] },
  },
}
```

How failure is handled, in order:

1. **Bounded same-model recovery** — transient rate limits and provider errors are retried
   before anything else, continuing the existing transcript so partial work survives.
2. **Auth-profile rotation** — a second credential for the same provider is tried.
3. **Model fallback** — the next model in the chain answers. This is **turn-local**: the
   session's selected model does not change permanently.

`modelPolicy.allow` is a separate control: it limits which models a user may switch to
in-session. Empty means "any".

> **On the originally requested models:** "GPT-4" and "Claude 3 Opus" are retired and no
> longer served by current provider endpoints. Hard-coding them would produce a config that
> fails on first call. Swap the primary line for whatever current frontier model you hold a
> key for.

---

## 7. Restricting access

The template ships with authentication already on:

```json5
gateway: {
  auth: {
    mode: "token",
    token: "${OPENCLAW_GATEWAY_TOKEN}",
    rateLimit: { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000, exemptLoopback: true },
  },
}
```

That is 10 failed attempts per minute before a five-minute lockout — brute-force throttling
at the Gateway boundary.

**Binding.** The template uses `bind: "custom"` with `customBindHost: "0.0.0.0"` because the
reference deployment is reached through a port proxy. **On a normal host, use `"loopback"`
unless you specifically need all-interface exposure:**

```bash
openclaw config set gateway.bind loopback
```

**Browser origins.** Only these origins may open Control UI / WebChat WebSockets:

```json5
gateway: { controlUi: { allowedOrigins: ["https://your-dashboard.example.com"] } }
```

Add the full origin (scheme + host, no trailing slash). `["*"]` allows any origin and is
documented as unsuitable outside tightly controlled local testing — never ship it publicly.

---

## 8. Verify

```bash
./scripts/verify.sh
```

Writes `reports/verification-report.md` and `reports/status.json`. With a provider key
present, all ten checks pass. Without one, checks 9 and 10 report `PENDING`.

---

## 9. Next steps

```bash
openclaw channels add          # Telegram, Discord, Slack, Signal, WhatsApp, …
openclaw cron add              # scheduled automations
openclaw dashboard             # open the Control UI with the current token
```

Channel behaviour is governed by pairing and allowlists — see the official docs before
exposing an assistant to a group chat.
