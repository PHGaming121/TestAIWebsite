# Tests (dev-only)

These suites are **not** part of the published site — `index.html` never references
them, so GitHub Pages simply ignores the folder.

They exercise the real app code: every suite copies `../js` into `tests/target/`,
loads the actual ES modules, and for the two DOM suites boots the real `../index.html`
inside jsdom with a mocked `window.puter` (and, in the integration suite, a mocked
`api.github.com` + Puter cloud filesystem). Nothing hits the network.

```bash
cd tests
npm install
npm run sync        # copy ../js into tests/target (only needed for `npm run lint`)
npm test            # 233 assertions across 3 suites
npm run lint        # eslint (one expected error: importScripts is a worker global)
```

| Suite | Assertions | Covers |
|-------|-----------|--------|
| `unit.test.mjs` | 95 | workspace CRUD/tree/describe, shell semantics (`ls` `cd` `cat` `head` `tail` `wc` `grep` `echo`/redirection/pipes), every one of the 25 agent tools, both tool-call protocols, conversation replay + history compaction, markdown sanitising, friendly AI-error mapping |
| `ui.test.mjs` | 96 | full boot of `index.html`, model picker, streaming chat with reasoning + markdown, agent loop across several model calls, approval modal, per-tool approval memory, text-protocol fallback, mid-run downgrade when a model rejects native tools, files/terminal panes, settings persistence, drag & drop upload, workspace panel open/close (close button, active-tab toggle, Ctrl+J, Esc, persisted state), the signed-out Puter billing pre-flight, CSS regression guards (`[hidden]` override, panel visibility), and a zero-runtime-error check |
| `integration.test.mjs` | 42 | GitHub connect, repo list/selection/auto-create, blob → tree → commit → ref push sequence, Pages enable, agent-driven `github_push`, PR + issue creation, Puter cloud filesystem backend, `deploy_to_puter`, `generate_image` |

`tests/target/` and `node_modules/` are generated — don't commit them.
