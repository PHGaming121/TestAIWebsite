this was fully vibecoded btw






# Puter Playground

**A free, unlimited AI playground that runs entirely in the browser — chat with any frontier model, or hand the task to an agent that writes files, runs code and ships the result to GitHub Pages.**

Live: **https://phgaming121.github.io/TestAIWebsite/**

No backend. No build step. No API keys. No sign-up wall. Everything is static files served from GitHub Pages; all intelligence comes from [Puter.js](https://docs.puter.com).

---

## Why it's free (and why "unlimited" is honest)

Puter.js runs a **user-pays** model: the AI calls are billed against *each visitor's own free Puter account*, not against the site owner. So this page has no key to leak, no quota to enforce, and no meter to run out — there is literally nothing in the code that could limit you. Signing in to Puter (free, one click, inside the app) raises your allowance and unlocks the cloud workspace and `*.puter.site` publishing.

The model list is **fetched live** from `puter.ai.listModels()` — 400+ models across OpenAI, Anthropic, Google, xAI, DeepSeek, Meta, Mistral and the open-source aggregators. A curated fallback list is used until the live catalogue arrives, and you can type any model id by hand.

---

## Features

### Chat mode
- Streaming Markdown with syntax-highlighted code blocks, copy/save buttons
- Collapsible "thinking" panel for reasoning models
- Image attachments (vision models), attachments-aware prompts
- Per-conversation model, temperature and reasoning effort
- Full history in the sidebar: search, rename, delete, export as Markdown/JSON
- Optional cross-device history mirror into your own Puter KV

### Agent mode
An autonomous loop with **25 tools**, native function calling *and* a fenced-JSON text protocol fallback (so models without tool support still work):

| Area | Tools |
|---|---|
| Files | `list_files` `read_file` `write_file` `edit_file` `delete_file` `make_directory` `rename_file` `search_files` |
| Execution | `run_shell` (mini POSIX shell) · `run_javascript` (sandboxed Worker) · `run_python` (real CPython via Pyodide) |
| GitHub | `github_status` `github_list_repos` `github_create_repo` `github_push` `github_list_files` `github_read_file` `github_create_branch` `github_open_pr` `github_create_issue` `github_enable_pages` |
| Puter | `deploy_to_puter` (publish to `*.puter.site`) · `generate_image` · `ask_user` · `finish` |

Every write/execute/publish step goes through an **approval gate** you can allow once, allow always, or bypass entirely with *Auto-approve*. The loop is capped by a configurable step budget and can be stopped mid-run with `Esc`.

### Four interchangeable workspaces
The agent works on whichever filesystem you pick — same API, same tools:

| Backend | What it is |
|---|---|
| **In-browser memory** | Instant, ephemeral, zero prompts |
| **Local disk (private)** | Your browser's OPFS storage — persists across reloads, never leaves the device |
| **Local folder…** | A **real folder on your computer** via the File System Access API (Chrome/Edge/Opera). The agent edits your actual files. |
| **Puter cloud drive** | `~/PlaygroundWorkspace` in your free Puter account — cross-device, and required for one-click `*.puter.site` publishing |

Plus: drag & drop import, ZIP export, an in-panel editor, syntax-highlighted viewer, a **live multi-file HTML preview** (inlines your local CSS/JS/images so relative paths work), and a terminal.

### Shipping it
- **GitHub**: connect a Personal Access Token → create a repo → push the workspace through the Git Data API (blobs → tree → commit → ref) → enable GitHub Pages. The agent can do all of this itself in one turn.
- **Puter**: publish straight to `https://<name>.puter.site`.
- **Local**: download the workspace as a ZIP, or export a web project as a single standalone HTML file.

---

## Quick start

1. Open the site (or run it locally, below).
2. Pick a model with `Ctrl+K` — or leave the default.
3. **Chat** for questions; flip to **Agent** (`Ctrl+2`) to build things.
4. Try a starter card, e.g. *"Build a Snake game, push it to a new public GitHub repo called `snake-game` and enable GitHub Pages."*
5. Watch the tool cards, approve what you like, then open the **Files** tab to preview and the **GitHub** tab for the live URL.

### Connecting GitHub
Paste a token in the **GitHub** tab:
- **classic** token with the `repo` scope, or
- **fine-grained** token with *Contents* and *Administration* read/write (Administration is only needed to create repos and toggle Pages).

Create one at <https://github.com/settings/tokens>. The token is stored in `localStorage` (or `sessionStorage` if you tick *"this tab only"*) and is only ever sent to `api.github.com`. GitHub Pages needs a **public** repo on a free plan.

### Running locally
Any static server works — no dependencies to install:

```bash
python3 -m http.server 8080     # then open http://localhost:8080
```

Notes: the File System Access API and OPFS need a secure context (`localhost` or `https`). Python execution lazy-loads Pyodide from jsDelivr on first use (~10 s, then cached).

### Deploying your own copy
Fork the repo → **Settings → Pages → Source: main branch, root** → done. All asset paths are relative, so it works at any sub-path.

### Going live on `phgaming121.github.io` (two clicks, needs an admin)
Automated deployment tools usually can't do these two steps — they need repo *administration* rights, which app/installation tokens are rarely granted. Both are quick:

1. **Settings → General → Danger Zone → Change visibility → Public.**
   GitHub Pages on a *private* repository requires a paid plan; making it public lets the free tier serve it.
2. **Settings → Pages → Build and deployment → Source: “Deploy from a branch”**
   → Branch: `main` (or `arena/c9ae3bd6-testaiwebsite` to preview the PR before merging) → Folder: `/ (root)` → **Save**.

About a minute later the playground is live at **https://phgaming121.github.io/TestAIWebsite/**. No build, no environment variables, no keys — the repo root *is* the site.

If you would rather not make the repo public, the app can publish itself to a free `https://<name>.puter.site` subdomain from the **Publish** tab instead (needs a free Puter sign-in, which the app does in one click).


---

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl/⌘ + Enter` | Send |
| `Ctrl/⌘ + K` | Search models |
| `Ctrl/⌘ + 1` / `Ctrl/⌘ + 2` | Chat / Agent mode |
| `Ctrl/⌘ + B` | Toggle sidebar |
| `Ctrl/⌘ + J` | Toggle workspace panel |
| `Ctrl/⌘ + Shift + N` | New conversation |
| `Esc` | Stop the agent |

---

## Project layout

```
index.html                 app shell (all panels, no framework)
assets/css/styles.css      design system + responsive layout
assets/vendor/             marked, DOMPurify, highlight.js, JSZip — bundled locally, no CDN
js/
  app.js                   bootstrap + wiring
  agent.js                 the agent loop, prompts, tool protocols, history compaction
  tools.js                 25 tool definitions (schemas + handlers)
  llm.js                   puter.ai.chat wrapper: streaming, tool accumulation, live model list
  workspace.js             one FS API over memory / OPFS / local folder / Puter cloud
  shell.js                 mini POSIX shell (pipes, &&, ||, ;, redirects, globs)
  exec.js                  JS Worker sandbox + Pyodide bridge
  github.js                GitHub REST + Git Data API client
  github-pane.js           GitHub tab UI
  publish-pane.js          Puter hosting / github.io / export UI
  panels.js                file tree, viewer, preview, terminal
  chat.js                  transcript rendering, streaming, tool cards
  modelpicker.js           live model catalogue UI
  settings.js              settings modal
  store.js                 conversations + settings persistence
  markdown.js  util.js  config.js  ui.js
  workers/                 js-sandbox.js, py-sandbox.js
tests/                     dev-only headless suite (jsdom) — see tests/README.md
```

## Security & privacy notes

- **Everything is client-side.** There is no server, no analytics, no telemetry in this repo.
- Model output is rendered through **DOMPurify** before it touches the DOM.
- Generated HTML previews run in a sandboxed iframe (`allow-scripts` only, no `allow-same-origin`).
- Agent code runs in a **Web Worker**: no DOM, no localStorage, no cookies. It is still your browser, so treat *Auto-approve* the way you'd treat `curl … | sh` — great for building, don't run code you wouldn't read.
- The **Local folder** backend writes to real files on your disk; the browser asks for permission and you can revoke it at any time.
- Your GitHub token never leaves the browser except in requests to `api.github.com`.

## Testing

**199 assertions** across three suites in [`tests/`](tests/), running the real app code under jsdom with a mocked `window.puter` and a mocked `api.github.com` — no network, no keys, no build step:

```bash
cd tests && npm install && npm test
```

| Suite | Assertions | Covers |
|-------|-----------|--------|
| `unit.test.mjs` | 88 | workspace CRUD/tree/describe, shell semantics (`ls` `cd` `cat` `head` `tail` `wc` `grep`, pipes, redirects), all 25 tool handlers, both tool-call protocols, history compaction, markdown sanitising |
| `ui.test.mjs` | 69 | boots the real `index.html`: model picker, streaming chat with reasoning, agent loop over several model calls, approval modal + remembered approvals, text-protocol fallback, mid-run downgrade when a model rejects native tools, files/terminal/github/publish panes, settings persistence, drag & drop, zero runtime errors |
| `integration.test.mjs` | 42 | GitHub connect, repo select/auto-create, blob → tree → commit → ref, Pages enable, agent-driven `github_push`, PRs + issues, Puter cloud backend, `deploy_to_puter`, `generate_image` |

The suites are dev-only and never referenced by `index.html`, so GitHub Pages ignores them.

## Credits

Built on [Puter.js](https://github.com/HeyPuter/puter) (Apache-2.0). Vendored libraries: marked (MIT), DOMPurify (MPL-2.0/Apache-2.0), highlight.js (BSD-3), JSZip (MIT) — see `assets/vendor/LICENSES.txt`.
