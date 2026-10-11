# OpenClaw Deployment — configuration, verification and docs

A reproducible OpenClaw setup: schema-validated configuration, model routing with
failover, the official token-reduction plugin, a verification harness that proves the
install works, and a static documentation site published to GitHub Pages.

**Current verified state** (see [`reports/verification-report.md`](reports/verification-report.md)):

| | |
|---|---|
| OpenClaw | `2026.10.1` (build `e178c39`) |
| Node runtime | `v26.11.1` |
| Configuration | `{"valid":true}` against OpenClaw's own schema |
| Gateway | live on `:18789`, `{"ok":true,"status":"live"}` |
| Checks passing | **8 / 10** — the remaining 2 need a provider API key |
| Plugin | `tokenjuice` (official token compaction) enabled |

---

## Quick start

```bash
# 1. install (checks Node, installs OpenClaw, writes + validates config, adds the plugin)
./openclaw/install.sh

# 2. supply credentials — never commit this file
cp openclaw/.env.example openclaw/.env && "$EDITOR" openclaw/.env
set -a; source openclaw/.env; set +a

# 3. run
./scripts/start-gateway.sh          # foreground Gateway + Control UI on :18789

# 4. prove it
./scripts/verify.sh                 # writes reports/verification-report.md
```

Requires **Node ≥ 24.16.0 or ≥ 26.1.0** (Node 26 recommended).

---

## Repository layout

| Path | Purpose |
| --- | --- |
| `openclaw/openclaw.json5` | Annotated configuration template. Secrets are `${VAR}` references, so it is safe to publish. |
| `openclaw/.env.example` | Every secret the setup expects, placeholders only. |
| `openclaw/install.sh` | Idempotent installer + schema validation. |
| `scripts/start-gateway.sh` | Validates, generates a gateway token on first run, launches the Gateway. |
| `scripts/verify.sh` | Runs the full checklist, writes Markdown + JSON reports. |
| `site/` | The GitHub Pages site (static, no external requests). |
| `docs/` | Setup, verification, troubleshooting, deployment and security guides. |
| `reports/` | Generated evidence from the last verification run. |
| `.github/workflows/pages.yml` | Publishes `site/` to Pages on every push to `main`. |

---

## Documentation

- **[docs/SETUP.md](docs/SETUP.md)** — full install, configuration, and the free-tier model path.
- **[docs/VERIFICATION.md](docs/VERIFICATION.md)** — what each check proves and how to complete the pending ones.
- **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — failure modes with exact remediation.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — where to host the Gateway, and why GitHub Pages cannot do it.
- **[docs/SECURITY.md](docs/SECURITY.md)** — secret handling, auth, rate limiting, compliance.
- **[docs/PLUGINS.md](docs/PLUGINS.md)** — the requested-vs-real plugin mapping, including what was declined.

---

## Two things worth knowing up front

**1. GitHub Pages cannot host OpenClaw.** It serves static files only — no long-running
process, no WebSocket listener, no persistent disk. The Gateway runs on a real host (your
machine, a VPS, Docker); Pages hosts this documentation. Full reasoning in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

**2. The setup is honest about what is unproven.** The Gateway runs and the config
validates — both independently confirmed. A live model reply was **not** verified, because
no provider API key was available in the build environment. That check reports `PENDING`
rather than quietly passing.

---

## License and attribution

The configuration, scripts and documentation here are yours to use freely. OpenClaw itself
is MIT-licensed and developed by the [OpenClaw Foundation](https://github.com/openclaw/openclaw).
