# OpenClaw verification report

Generated: `2026-10-11T19:15:31Z`  
Host runtime: `v26.11.1`  
OpenClaw: `OpenClaw 2026.10.1 (e178c39)`  
State dir: `/home/user/.cache/openclaw`

**8/10 passed · 0 failed · 2 pending (need an operator key)**

| Check | Status | Detail |
| --- | --- | --- |
| Node runtime supported | **PASS** | node v26.11.1 (requires >=24.16.0 or >=26.1.0) |
| OpenClaw CLI installed | **PASS** | 2026.10.1 (e178c39) |
| Config valid against schema | **PASS** | valid:true, no warnings |
| Model routing configured | **PASS** | primary=openrouter/anthropic/claude-sonnet-4-6; fallbacks=3 |
| Token-reduction plugin enabled | **PASS** | tokenjuice enabled |
| Gateway responding | **PASS** | GET http://127.0.0.1:18789/health -> {"ok":true,"status":"live"} |
| Control UI served | **PASS** | HTTP 200, text/html; charset=utf-8 |
| Gateway auth enforced | **PASS** | mode=token; auth rate limiting configured |
| Provider credential present | **PENDING** | no provider key in env or auth store — set OPENROUTER_API_KEY |
| End-to-end model reply | **PENDING** | skipped — requires a provider credential (check 9) |

> Checks marked PENDING require a provider credential that is not present in this
> environment. Supply one, then re-run `./scripts/verify.sh` to complete them.

Raw machine-readable output: `reports/status.json`
