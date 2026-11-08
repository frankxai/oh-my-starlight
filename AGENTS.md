# AGENTS.md — oh-my-starlight

Package home for OmS: measured model routing, receipts, the eval battery and the
harness adapters. Everything here is judged by a command, not by prose.

Estate-wide contracts still apply: `C:\Users\frank\starlight\AGENTS.md` and
`C:\Users\frank\starlight\repos\AGENTS.md`. This file adds only what is specific
to this repo.

## Before you change anything

1. Verify the target: `git rev-parse --show-toplevel`, `git remote get-url origin`,
   `git branch --show-current`. Product work happens on `agent/<harness>/<scope>`,
   never on `main`.
2. Claim the paths you will write: `node C:/Users/frank/starlight/tools/lane.mjs claim`
   and `starlight-ops claim` (the commit hook requires the second one).
3. Read `oms/manifest.json`. It is the package index; a file that ships must be
   listed there or `oms/verify.py` fails.

## The gate

```powershell
python oms/verify.py      # must print "oh-my-starlight package verified: releasable"
```

Any failing check means the package is not releasable. Do not commit around it.

## Conventions that are load-bearing

- **Schema is the source of truth.** Models, chains, caps and the battery
  definition live in `fleet/routing.schema.json`. Never hand-type a model list or
  a task count into prose.
- **Deterministic checkers only.** Battery tasks are graded by executing code and
  asserting on the result. No LLM judging in `harness_eval.py`.
- **Receipts are metadata.** A receipt may record model, latency, cost, task and
  outcome. Never a prompt body, a secret, or personal data.
- **Adapters stay thin.** A harness adapter writes one row in the shared receipt
  shape and nothing else.
- **No secrets in git.** gitleaks is armed at the estate root; env refs only.

## The jev package

`jev/` is the typed decision layer (TypeSafe Jev over the OpenRouter Decisions
API). Read `jev/CONTRACT.md` before touching it.

```powershell
cd jev
npm test                        # node --test "tests/*.test.mjs"
node src/cli.mjs check          # config + key presence, no network
node src/mcp.mjs                # stdio MCP server
```

Rules for `jev/`:

- Zero runtime dependencies in `src/` except the lazily imported MCP SDK.
- Tests never touch the network; `decide()` takes an injected `fetchImpl`.
- A missing key fails before any request. Never add a fallback that guesses.
- Receipts carry no key, no state body and no instruction text.
- `node --test tests/` fails on Node 24 (directory positional); use the glob.

## Handoff

A lane ends merged, closed with an archive tag, or as a HumanGate row with a
recommendation. Record the artifact path, the verification command and its exit
code, and the next bounded action.
