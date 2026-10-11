# Deployment guide

Where each component runs, why, and how to get the configuration live.

---

## The central constraint

**GitHub Pages cannot host OpenClaw.** This is not a configuration problem; it is a
mismatch between what the two things are.

OpenClaw's Gateway is a **stateful, long-running server process**. It holds:

- a WebSocket listener that clients connect to and hold open;
- a SQLite state store (sessions, auth profiles, transcripts);
- spawned worker processes;
- outbound connections to model providers and chat channels;
- in-memory state that exists only while the process lives.

GitHub Pages serves **static files**. No process, no listener, no persistent disk, no
secrets, no runtime. There is no arrangement of a static host that turns it into a
long-running stateful server.

So the deployment splits in two:

| Component | Host | Why |
| --- | --- | --- |
| **Gateway** | A machine you control — laptop, VPS, Docker host | It is a server. |
| **Documentation site** | GitHub Pages | It is static files. |

That is exactly what this repository does: `site/` is published to Pages; the Gateway runs
wherever you run `scripts/start-gateway.sh`.

### Why not put the API key in the web page?

A frequently-suggested workaround is to call model APIs straight from the browser. Two
problems:

1. **Any key in a published page is public.** Static hosting has no secret storage; the key
   is in the JavaScript for anyone who opens devtools. There is no client-side obfuscation
   that changes this.
2. **It is not OpenClaw.** Even if you accepted a public key, you would have a chat box, not
   an agent — no tool execution, no sessions, no memory, no channels, no plugins.

The Gateway exists precisely so the credential stays server-side and the browser holds only
a scoped session token.

---

## Option A — Your own machine (easiest)

```bash
./openclaw/install.sh
cp openclaw/.env.example openclaw/.env && "$EDITOR" openclaw/.env
set -a; source openclaw/.env; set +a
./scripts/start-gateway.sh
```

Open <http://127.0.0.1:18789/>.

Run it as a service so it survives logout and reboot:

```bash
openclaw gateway install      # systemd user unit (Linux/WSL2), LaunchAgent (macOS), Scheduled Task (Windows)
openclaw gateway status
```

For a remote host you reach over SSH, keep the Gateway on loopback and tunnel:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@your-host
```

That gives you the full Control UI with nothing exposed to the internet.

---

## Option B — VPS or cloud VM

```bash
# on a fresh Debian/Ubuntu box
curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -   # or your preferred Node install
sudo apt-get install -y nodejs
sudo npm install -g openclaw@latest

sudo useradd --system --create-home --shell /usr/sbin/nologin openclaw
sudo -u openclaw -H openclaw --version
```

Put the state directory outside the service account's home if you prefer:

```bash
sudo mkdir -p /var/lib/openclaw
sudo -u openclaw OPENCLAW_STATE_DIR=/var/lib/openclaw openclaw config validate
```

Install the service as that user, then:

```bash
openclaw gateway install
openclaw gateway status
```

**Firewall.** Do not expose 18789 to the internet directly. Prefer, in order:

1. **Tailscale / WireGuard** — reachable only from your own devices. OpenClaw has
   first-class Tailscale support (`gateway.tailscale`, `openclaw dns`).
2. **An authenticating reverse proxy** — TLS terminated upstream, with
   `gateway.auth.mode: "trusted-proxy"` only if the proxy genuinely is identity-aware.
   Getting this wrong means trusting attacker-supplied headers.
3. **Direct exposure with token auth** — the minimum acceptable baseline: a long random
   token, rate limiting on, origin allowlist explicit, and `publicOrigin` set so links are
   generated correctly.

If you terminate TLS upstream, set:

```json5
{
  gateway: {
    publicOrigin: "https://claw.example.com",
    trustedProxies: ["127.0.0.1"],
    controlUi: { allowedOrigins: ["https://claw.example.com"] },
  },
}
```

---

## Option C — Docker / Podman

OpenClaw supports containerised operation (see the official Docker docs for the maintained
image and compose file). The essentials:

- Persist the state directory as a volume — it holds sessions, config and auth profiles.
- Publish the port deliberately (`-p 127.0.0.1:18789:18789` keeps it local).
- Pass secrets via `--env-file`, never via image layers.
- If the container is reached through a host port proxy, remember the Gateway must bind
  inside the container on `0.0.0.0` to be reachable — which is why the shipped template uses
  `bind: "custom"` + `customBindHost: "0.0.0.0"`.

---

## Publishing this site to GitHub Pages

The workflow at `.github/workflows/pages.yml` deploys `site/` on every push to `main`.

**One-time repository setup:**

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push to `main` (or run the workflow manually from the Actions tab).

The workflow stages `site/`, adds `.nojekyll` (so Jekyll does not drop underscore-prefixed
paths), sanity-checks that `index.html` and the stylesheet exist, **fails the build if it
detects anything resembling a credential in the artifact**, then deploys.

**Add your Pages origin to the Gateway allowlist** so the dashboard origin is permitted:

```bash
openclaw config set gateway.controlUi.allowedOrigins \
  '["https://YOUR-USER.github.io","https://YOUR-DOMAIN.example.com"]'
```

### Custom domain

Add a `CNAME` file containing your domain to `site/`, then add the same origin to
`gateway.controlUi.allowedOrigins`. Keep the allowlist in sync with reality — a stale entry
is a hole, and a missing entry is an outage.

---

## Choosing a Gateway host

| Host | Good for | Watch out for |
| --- | --- | --- |
| Laptop + `gateway install` | Personal assistant | Asleep when the lid closes |
| Small VPS | Always-on assistant | Give it enough RAM for your session sizes |
| Home server / Pi | Privacy, no monthly cost | Cold starts; set `NODE_COMPILE_CACHE` |
| Docker on a NAS | Convenient persistence | Volume must persist, or you lose sessions |
| Serverless / static host | — | Cannot run a stateful server. Not an option. |

---

## Deployment checklist

```bash
# on the Gateway host
node -v                                  # supported version
./openclaw/install.sh                    # or: npm i -g openclaw@latest + config
./scripts/start-gateway.sh &             # or: openclaw gateway install
openclaw gateway status
./scripts/verify.sh                      # expect 10/10 with a provider key
```

```bash
# on the repository
git push origin main                     # triggers the Pages workflow
gh run watch                             # or check the Actions tab
```

Then confirm:

- [ ] `openclaw config validate` reports valid, no warnings.
- [ ] `/health` returns `{"ok":true,"status":"live"}`.
- [ ] The Control UI opens and accepts your token.
- [ ] `openclaw models status` shows no `indeterminate` routes.
- [ ] A real reply comes back (`verify.sh` check 10).
- [ ] The Gateway is not reachable from the public internet unless you intend it to be.
- [ ] The Pages site loads, and no secret appears anywhere in `site/`.
