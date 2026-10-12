# Forge — CodeCraft Playground

Forge is a browser-only coding playground for the OpenAI-compatible [CodeCraft API](https://codecraftapi.com/docs). It can chat with models on your CodeCraft account, inspect a local project, load Claude-format skills as model context, compress the request before it is sent, and push a batch of approved edits to a GitHub branch.

Everything runs in the tab. There is no Forge server, no build step and no bundled key.

---

## 1. Token saver (context compression)

Forge compresses the **request copy** of the conversation before it leaves the browser. Your prompt, the transcript you can see, and every file in your workspace stay exactly as they are — only what is sent to the provider changes, and every request reports what it removed.

Open the saver panel in the right-hand inspector, or press the **Saver · Balanced** chip above the message box.

### Profiles

| Profile | What it does | Rewrites text? |
| --- | --- | --- |
| **Off** | Sends the conversation verbatim. | No |
| **Safe** | Collapses whitespace, drops blank lines, replaces duplicate file reads with a pointer. | No |
| **Balanced** (default) | Adds code-comment trimming, prose tightening on older assistant turns, older-turn summarisation, stale file-body pruning and tool-schema slimming. | Yes, on the request copy only |
| **Aggressive** | Also elides large code bodies down to their signatures. Best for very long sessions; the model may need to re-read a file before rewriting it. | Yes, more of it |

### Techniques, in the order they run

1. **Whitespace and blank lines** — trailing spaces, doubled spaces in prose, runs of blank lines.
2. **Code comment trimming** — language-aware and string-aware: comments are removed, but URLs in strings, regex literals, template literals, Python docstrings, `#!`, `eslint-disable`, `@ts-`, `TODO`, `NOTE:` and other directives survive. Verified by re-parsing the repository's own JavaScript after trimming (`tests/unit.test.mjs`).
3. **Prose tightening** — filler phrases ("in order to" → "to"), duplicated sentences, emphasis markers on older assistant turns only.
4. **Older turn summarisation** — extractive: keeps the first sentence, decisions, numbers, errors and file paths; drops old code blocks down to a reminder line.
5. **Stale file pruning** — a file read that is older than the verbatim window becomes `path [forge:compressed] pruned from older context … Call read_file("path") to load it again`. Nothing is lost: the agent re-reads on demand and the workspace is untouched.
6. **Duplicate read suppression** — if the same file with identical content appears twice *inside one request*, the second copy becomes a pointer. It never points at a copy that is not in the request.
7. **Tool schema slimming** — trims long tool and parameter descriptions, which are re-sent on every agent round. Names, types and `required` lists are never changed.
8. **Instruction block compaction** — `CLAUDE.md` and skill markdown are compacted losslessly before they enter the system message.

### Measured savings

The saver measures every request with its own estimator, so the UI shows real numbers rather than a promise. The bundled samples (`Run sample benchmark` in the dialog) give:

| Sample | Safe | Balanced | Aggressive |
| --- | --- | --- | --- |
| 6-turn chat session | 15% | **40%** | 51% |
| 20-turn chat session | 27% | **61%** | 63% |
| 30-turn chat session | 28% | **63%** | 66% |
| 12-turn agent session with commented files | 36% | **58%** | 61% |
| 20-turn agent session, comment-dense modules | — | **80%** | — |

Reproduce any of these without a browser:

```bash
node -e "const C=require('./compressor.js');for(const t of [6,20,30])console.log(t, C.benchmark({profile:'balanced',turns:t}).savedPct+'%')"
node -e "const C=require('./compressor.js');console.log(C.benchmark({profile:'balanced',scenario:'agent',turns:12}))"
```

Short conversations save little because there is little to compress — the newest turn is never rewritten. Savings grow with history and with the number of file reads, which is exactly where a long CodeCraft session burns tokens. Use **Preview this conversation** to measure your own session.

Lossy techniques are labelled **REWRITE** in the report; whitespace-only ones are labelled **LOSSLESS**.

---

## 2. Claude skill adder

Point Forge at a folder or repository and it recognises Claude markdown, validates it, and loads it into the model context.

| File | Treated as |
| --- | --- |
| `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` (root or nested) | Project instructions ("memory"), injected into the system message |
| `**/SKILL.md`, `.claude/skills/<name>/SKILL.md` | An Anthropic-format skill |
| any `.md` with `name` + `description` front matter | A skill (flagged as detected by front matter) |
| `.claude/commands/*.md` | Slash commands |
| `.claude/agents/*.md` | Sub-agent definitions |
| Files next to a `SKILL.md` | Bundled resources (`scripts/`, `references/`, `assets/`) |

### Progressive disclosure, the way skills are meant to work

- **Chat mode** gets the full instruction files plus the skill index, and inlines small skill bodies (≤1400 characters each).
- **Agent mode** gets the index plus three tools — `list_skills`, `read_skill`, `read_skill_resource` — so full skill text is loaded only when a task matches. This is cheaper and keeps the context focused.

### Validation

Skill front matter is parsed with a small YAML subset parser (scalars, quoted strings, lists, nested maps, block scalars). Forge reports problems instead of silently "fixing" them:

- `name` must be lowercase letters, digits and single hyphens, ≤64 characters, and must not start with `claude` or `anthropic`
- `description` is required and capped at 1024 characters
- missing front matter, short descriptions, empty bodies, bodies over 500 lines, and oversized instruction files are all flagged

Add skills by **Add skill file** (multi-select markdown), **Paste a skill** (Forge writes the front matter for you), or **Download template** to start a `SKILL.md`. Skills added in the tab live for that tab only; to keep one permanently, save it into the workspace (for example `.claude/skills/name/SKILL.md`) and push it.

Skill content is workspace data, not user chat. It is wrapped in `<skill …>` / `<project_instructions …>` delimiters and the model is told to treat it as project instructions that never override safety rules or ask for secrets. Read any skill before you load it — Forge tries to make that easy by showing the parsed description, the allowed tools and the body in the UI.

---

## 3. Troubleshooting: when the page or the sign-in does not load

### "The page doesn't load" — GitHub Pages is not publishing

If `https://<owner>.github.io/<repository>/` answers with GitHub's *"There isn't a GitHub Pages site here"* page, Pages is not enabled for the repository, so the Forge files are never served. The deploy workflow failed at the `Configure Pages` step when this was last checked.

The workflow now handles this itself. It asks GitHub to create the Pages site (`enablement: true`), which is what fixed this repository — the site is live at <https://phgaming121.github.io/TestAIWebsite/> and deploys on every push to `main`. If a future token is not allowed to create the site, the same run publishes the identical files to a `gh-pages` branch instead, keeps the run green, and puts the two settings to change in the run summary:

1. **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
2. Branch: **`gh-pages`**, folder: **`/ (root)`** → **Save**.

To check which path a run took, open **Actions → Deploy Forge to GitHub Pages**: a green *Deploy to GitHub Pages* job means the Actions source is in use; the *Fallback publish to gh-pages* job only runs when it is not.

### "I can't sign in" — the CodeCraft browser check

`codecraftapi.com/login` sits behind a Cloudflare browser check ("Checking your Browser…"). Two different things can go wrong:

- **The sign-in page spins forever.** The challenge never completes. Try a private window with extensions off, another network (a phone hotspot is ideal), and check the device clock — a skewed clock fails the challenge. Then sign in once from a normal tab; the clearance cookie is what unblocks key requests too.
- **The sign-in page loads, but `Save & test` in Forge fails with a network error.** That request goes straight from this page to `codecraftapi.com`. A browser check, a content blocker, a VPN or a company proxy will make it look like a dead connection. Press **Connection doctor** in the API dialog: it reports your page origin, connectivity, whether the host answers with a browser-check page rather than JSON, whether your key is accepted, and a copyable report (no key included) that says exactly which of those it was.

Quick checklist for the second case:

1. Sign in to CodeCraft in this browser first, then retry.
2. Disable privacy shields/blockers for the API host.
3. Serve Forge over http(s). Opening `index.html` from disk sends `Origin: null`, which most APIs reject — start `python3 -m http.server 8000` and use `http://localhost:8000`.
4. Only if a network you do not control still blocks browser requests: run your own OpenAI-compatible gateway in front of CodeCraft and put its URL in **Advanced → API base URL** (persisted locally; the key is still sent only to that host).

---

## Run locally

```bash
python3 -m http.server 8000     # or: npm run serve
```

Then open `http://localhost:8000`. A secure context (HTTPS or localhost) is required for the browser's writable folder picker. No API keys are bundled in the site.

## Tests

```bash
npm install --no-save jsdom      # only needed for the browser smoke test
npm test                         # 26 unit tests + 7 end-to-end tests
npm run test:unit                # compressor + skills, no dependencies
```

The unit suite covers the token estimator, the comment scanner (including string/regex/URL survival and re-parsing real files), the profile guarantees, budget enforcement, tool-schema slimming, skill discovery, front-matter parsing, validation and context building. The browser suite boots the real `index.html` in jsdom, stubs the CodeCraft API, and drives connect → workspace scan → skills injection → agent tool rounds → savings badge → connection doctor. It skips itself if jsdom is absent.

## Connect CodeCraft

1. Create a key in your [CodeCraft dashboard](https://codecraftapi.com/dashboard) with the scopes needed for inference and model listing.
2. In Forge, choose **Connect API** and paste the key.
3. Forge fetches `GET https://codecraftapi.com/v1/models`, then sends chat requests to `POST https://codecraftapi.com/v1/chat/completions`.

The key is held in JavaScript memory for the current tab only; it is not written to local storage, a cookie, or a Forge server. Refreshing or closing the tab clears it. Only non-secret preferences (compression profile, API base URL) are persisted. Requests go directly from the browser to CodeCraft; a provider-side CORS or browser-check policy can prevent them and Forge does not proxy or bypass those controls.

## Important: usage and cost

Forge has **no application-level usage counter or cap**. The token saver reduces how many input tokens a request carries, which usually means more conversation per unit of allowance — it does **not** make model access free or unlimited. CodeCraft account allowances, rate limits, model pricing, and upstream availability still apply; check your CodeCraft dashboard. This project does not provide or subsidize API credits.

## Agent workspaces

### Local folder

On browsers with the File System Access API (typically Chromium-based browsers on HTTPS or localhost), **Local folder** grants read/write access to the folder you choose. Forge reads supported text files into tab memory and asks you to approve each file write before saving it. The agent has no shell or terminal access.

On browsers without a writable folder picker, Forge imports a selected folder read-only. Approved edits stay in tab memory and can be downloaded as a ZIP while the page is open.

### GitHub repository

- Public repositories can be loaded without a GitHub token; private repositories require a token with read access.
- To push staged agent edits, provide a fine-grained GitHub personal access token scoped to the target repository with **Contents: read and write**. Add **Workflows: read and write** only if you intentionally edit files under `.github/workflows/`. Prefer the narrowest scope available.
- The token stays in tab memory. Forge creates a Git commit on the selected branch using the GitHub REST API; review the staged file changes before pushing.

Forge loads a bounded set of text files (up to 140 files / about 720,000 characters; individual files are limited to 180 KB). Dependency, build and binary directories are skipped.

## Console helpers

`window.ForgeDebug` is available for support and testing and never exposes keys:

```js
ForgeDebug.snapshot()        // counters: files, skills, saver runs, savings %
ForgeDebug.compress(messages, { profile: 'balanced' })
ForgeDebug.benchmark({ scenario: 'agent', turns: 12 })
ForgeDebug.systemMessage()   // exactly what the model receives as the system prompt
```

## Deploy to GitHub Pages

The workflow at `.github/workflows/pages.yml` publishes the static app when changes reach `main` and on manual dispatch. It builds `_site/`, checks that every site file exists and parses, enables Pages if needed, deploys, and falls back to a `gh-pages` branch publish when the Pages API refuses.

The static app needs no server-side secrets. The deployed app still requires each user to bring their own CodeCraft key; users who push to GitHub also bring their own GitHub token.

## Browser and security notes

- Do not paste credentials into the chat. Use the dedicated connection forms, and avoid shared or untrusted devices.
- API calls are made directly to CodeCraft and GitHub from the browser. Use provider documentation and account settings to understand data handling, billing, and access scopes.
- Review every proposed local write and every staged GitHub change. Forge intentionally does not execute repository code or shell commands.
- Compression rewrites only the request copy. Nothing on disk, and nothing in the transcript you can read, is modified — verify with **Preview this conversation** and the `LOSSLESS` / `REWRITE` labels.
- GitHub Pages is a public static host. Never place a real API key, access token, or private source code in the published files.
