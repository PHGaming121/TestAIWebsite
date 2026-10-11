this was fully vibecoded btw






# Puter Playground

**A free AI playground that runs entirely in the browser — chat with any frontier model, or hand the task to an agent that writes files, runs code, generates images and video, remembers you between sessions, uses skills imported from Claude/ChatGPT/Gemini, and ships the result to GitHub Pages.**

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
An autonomous loop with **36 tools**, native function calling *and* a fenced-JSON text protocol fallback (so models without tool support still work):

| Area | Tools |
|---|---|
| Files | `list_files` `read_file` `write_file` `edit_file` `delete_file` `make_directory` `rename_file` `search_files` |
| Execution | `run_shell` (mini POSIX shell) · `run_javascript` (sandboxed Worker) · `run_python` (real CPython via Pyodide) |
| Media | `generate_image` (incl. image-to-image editing) · `generate_video` (first/last frame, reference images, soundtrack) |
| Memory | `remember` · `recall` · `forget` |
| Skills | `list_skills` · `use_skill` · `create_skill` · `import_skill` |
| Connections | `list_connections` · `call_connection` · `web_fetch` (reads any public page) |
| GitHub | `github_status` `github_list_repos` `github_create_repo` `github_push` `github_list_files` `github_read_file` `github_create_branch` `github_open_pr` `github_create_issue` `github_enable_pages` |
| Puter | `deploy_to_puter` (publish to `*.puter.site`) · `ask_user` · `finish` |

Every write/execute/publish/network step goes through an **approval gate** you can allow once, allow always, or bypass entirely with *Auto-approve*. The loop is capped by a configurable step budget and can be stopped mid-run with `Esc`.

### Images and video
A **Create** tab (and the two agent tools) drives `puter.ai.txt2img` and `puter.ai.txt2vid`: model, provider, quality and size tiers, aspect ratio, negative prompt, seed and steps for images; clip length, output size, first/last frame, reference images, soundtrack and fps for video. Any image in the workspace can be used as an image-to-image reference or a video's first frame, so you can iterate.

**"Free sample" is on by default.** Both drivers accept a test mode that returns a sample *without spending credits* — use it to check a prompt before paying for the real thing.

Results are saved under `media/`, shown inline in the chat as media cards, previewable in the Files tab (images, video and audio), and downloadable. The bytes never go back into the model's context — only the path does — so a 10 MB clip costs you nothing in tokens.

### Long-term memory
A **Memory** tab holds durable facts about you: preferences, environment, projects, standing decisions. They are injected into the system prompt of *every* conversation (pinned ones always, the rest matched against what you just asked), so the agent stops re-asking questions it already knows the answer to.

Retrieval is offline and instant — phrase hits, shared tokens, a light stemmer (*prefers* ↔ *preference*, *ships* ↔ *shipping*), tags, then pinned/recency as a tiebreaker. No embeddings, no model call, no credits spent on lookup. The agent has `remember` / `recall` / `forget`; `forget` refuses to guess when several memories match equally and asks for the exact id instead.

**Distil from a conversation** asks a model to propose memories from the open chat. It is the only model call memory ever makes, it is never automatic, it is instructed not to record secrets, and nothing is stored until you tick individual candidates. Optionally mirror the whole store into **your own Puter KV** so it follows you across devices (merged by text, newest edit wins).

### Connections: other providers and other apps
The **Connect** tab has two independent halves.

*Which AI answers* — Puter stays the default (no key, 400+ models), but any OpenAI-compatible endpoint can take over: **Ollama** or **LM Studio** on your own machine, **Pollinations** with no signup at all, plus OpenRouter, Groq, Gemini, Mistral, DeepSeek, NVIDIA NIM, Together, OpenAI, or a custom URL. One adapter covers them, and the model picker follows the switch.

Two browser realities are handled explicitly:
- **CORS.** When a direct fetch is refused, the call is retried through `puter.net.fetch`, which proxies without CORS. That proxy is XHR-backed and cannot stream, so the retry asks for a single completion instead of an SSE stream — the answer arrives whole rather than as unparseable fragments.
- **localhost.** Puter's proxy runs on their servers and can never reach `127.0.0.1`, so local endpoints always go direct, and a failure names the fix (`OLLAMA_ORIGINS`, LM Studio's CORS switch).

Keys live in your browser's localStorage and are sent only to their own endpoint.

*Apps the agent can call* — a connection is a base URL plus an auth scheme (none, bearer, custom header, basic, or reuse your GitHub token). Keyless presets are one click: DuckDuckGo Instant Answers, Wikipedia REST, Hugging Face Hub, GitHub. `web_fetch` reads any public page through a dependency-free HTML reduction pass, so the playground can look things up instead of guessing. It refuses loopback addresses rather than letting a prompt wander into your LAN, and both network tools sit behind their own approval tier.

### Skills
The **Skills** tab speaks the [Agent Skills open standard](https://agentskills.io) — a folder with a `SKILL.md` (YAML frontmatter + Markdown instructions), published by Anthropic and now read by ChatGPT, Codex, Gemini CLI, VS Code, Copilot, Cursor and ~30 other agents. Import one and it works everywhere; write one here and other agents can read it.

Import detects the format automatically: `SKILL.md`, a **ChatGPT custom-GPT** JSON export (instructions, greeting, knowledge files and API actions), a **Gemini Gem**, a `CLAUDE.md`/`AGENTS.md` rules file, an OpenAPI spec, plain Markdown, or a `.zip` with its `scripts/`, `references/` and `assets/` intact. You can also import from a URL. Skills are stored in the workspace under `skills/<name>/`, so they push to GitHub with everything else, and discovery also reads `.claude/skills`, `.agents/skills` and `.gemini/skills`.

Progressive disclosure keeps the cost down: only each skill's name and description enter the prompt (~100 tokens each); `use_skill` loads the body when a task matches; bundled files are read on demand.

**A skill is third-party instructions, so it is treated as untrusted by default.** `allowed-tools` is never honoured automatically — the row shows what the skill asks for, maps Claude's tool names onto this app's, and each grant is an explicit click you can revoke. Imported skills are badged *unreviewed* until you mark them reviewed, invalid skills are listed with their spec errors instead of silently loading, and the prompt states plainly that a skill cannot widen permissions, skip an approval, or override your request.

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
  tools.js                 36 tool definitions (schemas + handlers)
  llm.js                   puter.ai.chat wrapper: streaming, tool accumulation, live model list, error translation
  providers.js             OpenAI-compatible adapter (Ollama, OpenRouter, Groq, Gemini, …) + CORS/loopback transport
  connections.js           external apps the agent can call, and web_fetch's HTML reduction
  media.js                 txt2img / txt2vid: option mapping, element→bytes, credit-free test mode
  memory.js                long-term memory: ranking, prompt injection, Puter KV mirror, distillation
  skills.js                Agent Skills: parse, validate, discover, import (ChatGPT/Gemini/Claude), prompt index
  media-pane.js  memory-pane.js  connections-pane.js  skills-pane.js     the Create / Memory / Connect / Skills tabs
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

**534 assertions** across three suites in [`tests/`](tests/), running the real app code under jsdom with a mocked `window.puter` and a mocked `api.github.com` — no network, no keys, no build step:

```bash
cd tests && npm install && npm test
```

| Suite | Assertions | Covers |
|-------|-----------|--------|
| `unit.test.mjs` | 294 | workspace CRUD/tree/describe, shell semantics (`ls` `cd` `cat` `head` `tail` `wc` `grep`, pipes, redirects), tool handlers, both tool-call protocols, history compaction, markdown sanitising, friendly AI-error mapping, media option mapping and result normalisation, memory ranking/stemming/distillation/merge, provider config and OpenAI-compatible chat (streamed and not, including the CORS-proxy fallback), connection auth schemes, `web_fetch` guards and HTML extraction, SKILL.md parsing and spec validation, and every skill importer |
| `ui.test.mjs` | 69 | boots the real `index.html`: model picker, streaming chat with reasoning, agent loop over several model calls, approval modal + remembered approvals, text-protocol fallback, mid-run downgrade when a model rejects native tools, files/terminal/github/publish panes, settings persistence, drag & drop, zero runtime errors |
| `integration.test.mjs` | 42 | GitHub connect, repo select/auto-create, blob → tree → commit → ref, Pages enable, agent-driven `github_push`, PRs + issues, Puter cloud backend, `deploy_to_puter`, `generate_image` |

The suites are dev-only and never referenced by `index.html`, so GitHub Pages ignores them.

## Credits

Built on [Puter.js](https://github.com/HeyPuter/puter) (Apache-2.0). Vendored libraries: marked (MIT), DOMPurify (MPL-2.0/Apache-2.0), highlight.js (BSD-3), JSZip (MIT) — see `assets/vendor/LICENSES.txt`.
