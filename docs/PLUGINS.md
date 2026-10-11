# Plugins — requested vs. reality

Three plugins were requested by name. Two of those names match no published package, and
one is not an OpenClaw plugin at all. This document records what was searched, what was
found, and what was installed instead.

## Summary

| Requested | Exists? | Action taken |
| --- | --- | --- |
| Token Economy Plugin | No package by that name | Installed `@openclaw/tokenjuice` |
| Skill Addition Plugin | No package by that name | Configured the core skills subsystem |
| G0DMOD3 Plugin | Exists as a standalone web app, not an OpenClaw plugin | Not integrated — see below |

---

## 1. "Token Economy Plugin"

**Finding: no such package exists.** No OpenClaw plugin by this name is published on npm or
listed in OpenClaw's own plugin inventory (164 entries). Searches for it return unrelated
token/blockchain projects.

**What was installed instead:** [`@openclaw/tokenjuice`](https://www.npmjs.com/package/@openclaw/tokenjuice)
— an official, OpenClaw-maintained plugin that compacts noisy `exec` and `bash` tool results
*before* they re-enter the context window.

```bash
openclaw plugins install @openclaw/tokenjuice
openclaw config set plugins.entries.tokenjuice.enabled true   # or: openclaw plugins enable tokenjuice
```

**Why this is the right substitute.** In agent loops the dominant token cost is not the
user's prompt — it is the accumulated tool output flowing back into context. Tool results
are frequently the largest single contributor to context growth. Tokenjuice targets exactly
that, and it is deliberately conservative about it:

- It rewrites the returned `tool_result`, never the command itself — no re-execution, no
  change to exit codes.
- Exact file-content reads stay raw; only standalone repository-inventory commands are
  compacted; unsafe mixed command sequences are left alone.
- It is opt-in and fully reversible (`openclaw plugins disable tokenjuice`).

### The other token sinks, and which config keys bound them

Tokenjuice handles tool output. Everything else that inflates the prompt is bounded by
configuration, and the shipped template sets these:

| Lever | Config key | Default / shipped |
| --- | --- | --- |
| Skills index in the system prompt | `skills.limits.maxSkillsPromptChars` | shipped: `4000` |
| Per-file bootstrap injection | `agents.defaults.bootstrapMaxChars` | default `20000` |
| Total bootstrap injection | `agents.defaults.bootstrapTotalMaxChars` | default `60000` |
| Image payload downscaling | `agents.defaults.imageMaxDimensionPx` | default `1200` |
| Memory-tool excerpt size | `agents.defaults.contextLimits.memoryGetMaxChars` | schema-bounded |
| Post-compaction retention | `agents.defaults.contextLimits.postCompactionMaxChars` | schema-bounded |

OpenClaw additionally derives the live tool-result cap from the model's context window
(16k / 32k / 64k characters at <100k / 100k+ / 200k+ tokens) and caps any single tool result
at 30% of the window.

### On "spending limits"

There is **no dollar-value budget key** in OpenClaw's configuration schema. Setting one
would fail validation, because the schema is strict about unknown keys. Cost control is
therefore split:

- **Hard caps** belong in your provider account (OpenRouter, Anthropic, OpenAI all expose
  spend limits). This is the only place a limit is actually enforced.
- **Visibility** comes from OpenClaw: `/status` for the current session, `/usage cost` for a
  running footer, **Control UI → Usage** for cross-session breakdowns by provider/model/day,
  and `openclaw status --usage` for provider rate-limit windows such as `X% left`.
- **Blast-radius reduction** comes from the token levers in the table above, plus model
  policy (`agents.defaults.modelPolicy.allow`) to prevent surprising expensive-model use.

---

## 2. "Skill Addition Plugin"

**Finding: no such package exists.** This is because skills are not a plugin surface in
OpenClaw — they are a **core subsystem**, present in every install.

**What was configured instead:** the core skills subsystem.

```json5
{
  skills: {
    limits: { maxSkillsPromptChars: 4000 },
    // entries: { "<skill>": { enabled: true, apiKey: "${SOME_KEY}", env: {...} } }
  }
}
```

Skills load instructions **on demand** with the `read` tool rather than being pasted into
every prompt — only skill *metadata* occupies the system prompt, bounded by
`maxSkillsPromptChars`. That is the token-efficient architecture, and it is why no
"expansion module" is needed: adding capability means adding a skill directory (or
installing one from the skills registry), not installing a plugin.

---

## 3. "G0DMOD3 Plugin" — not installed, deliberately

**Finding: `G0DMOD3` exists, but it is not an OpenClaw plugin, and integrating it conflicts
with this project's own constraints.**

What it actually is (`github.com/icarnevale/G0DMOD3`, AGPL-3.0, mirrored from
`elder-plinius/G0DMOD3`): a standalone multi-model chat front-end — a single-page web app
built for static hosting. Its README describes:

> *"LIBERATED AI. COGNITION WITHOUT CONTROL."*

and ships:

- **GODMODE CLASSIC** — *"5 proven model + prompt combos ... Each combo pairs a specific
  model with a battle-tested jailbreak prompt."*
- **Parseltongue** — *"Input perturbation engine for red-teaming ... Detects trigger words
  and applies obfuscation techniques."*
- **STM Modules** — output normalisation to strip hedging and refusals.

### Why it is not here

**It is technically inert for this purpose.** It has no OpenClaw plugin manifest and no
plugin entry point. `openclaw plugins install` has nothing it can load; it is a web page for
a static host, not a Gateway extension.

**It conflicts with the stated constraints.** Integrating tooling whose documented purpose
is defeating model safety behaviour and other providers' guardrails would:

- breach the terms of service of every upstream model API it targets — directly contradicting
  the compliance requirement in the original brief;
- require this project to ship and maintain jailbreak prompt sets, which is not something
  this deployment does.

### If the underlying goal was "one front-end, many models"

That is already satisfied here without the bypass tooling: the OpenClaw **Control UI** at
`:18789` talks to the Gateway, and the configured OpenRouter routing reaches
Anthropic/DeepSeek/Meta models (and more) through one credential. Add a channel — Telegram,
Discord, Slack, Signal — and you get a multi-model assistant in the apps you already use.

### A note on the similarly-named npm package

Searching turns up `@godmode-team/godmode` ("Personal AI Operating System plugin for
OpenClaw"). It is a **different project** that happens to share a name, published by an
unaffiliated third party. It is not part of OpenClaw's official plugin inventory. It was
not installed: third-party plugins receive deep agent permissions, and it has no track
record in the official inventory. If you want to evaluate it yourself, install it in a
throwaway environment first and inspect it:

```bash
openclaw plugins install @godmode-team/godmode
openclaw plugins inspect godmode --runtime --json
```

---

## Verifying plugin state

```bash
openclaw plugins list                      # discovered plugins + enabled/disabled
openclaw plugins inspect tokenjuice --runtime --json
openclaw plugins doctor                    # load errors
openclaw plugins validate                  # metadata + Control UI assets
```

`./scripts/verify.sh` asserts that `tokenjuice` is present **and** enabled; a plugin that is
installed but disabled fails the check.
