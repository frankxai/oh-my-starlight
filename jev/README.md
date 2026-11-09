# Jev decision layer

Typed decisions for agent workflows. TypeSafe **Jev** is a System One decision
model: you send a `state` and closed questions, it returns probabilities, and
your code branches. No prose, no parse-the-model-output step, no tool interface.

This package is the estate's adapter: a zero-dependency client, a CLI, an MCP
server, reusable policies, and a skill that tells an agent when to route a
decision here instead of asking an LLM to guess.

```
state + questions ──► Jev ──► {noul | choice | score} ──► verdict bands ──► accept | review | reject
```

## Why this exists

Prompt-and-parse is the usual way an agent classifies, routes, or gates. It is
irreproducible, uncalibrated, and costs output tokens for text you throw away.
Jev replaces that step with a typed answer you can threshold, log and regression
test. Input is billed, output is free, context is 262k.

It is not a chat model and cannot be a subagent model. Anything needing
reasoning, explanation or tools stays with the LLM; Jev only answers the narrow
question you wrote.

## Quick start

```powershell
cd C:\Users\frank\starlight\repos\oh-my-starlight

# 1. config check, no network
node jev/src/cli.mjs check

# 2. first decision (needs OPENROUTER_API_KEY or JEV_API_KEY_FILE)
node jev/src/cli.mjs decide --state jev/examples/state.json --questions jev/examples/questions.json --policy review-gate

# 3. same call over MCP stdio
node jev/src/mcp.mjs
```

Exit codes: `0` accept, `3` review or reject, `2` usage or config, `1` request or
parse.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | Key used for the Decisions API | none |
| `JEV_API_KEY` | Explicit override, any provider | none |
| `JEV_API_KEY_FILE` | Path to a file holding the key | none |
| `JEV_BASE_URL` | API base | `https://openrouter.ai/api` |
| `JEV_ROUTE` | `decisions` (`/alpha/decisions`) or `systemone` (`/v1/systemone`) | `decisions` |
| `JEV_MODEL` | Model id | `typesafe/jev-1.13` |
| `JEV_TIMEOUT_MS` | Per-attempt timeout | `20000` |
| `JEV_MAX_RETRIES` | Retries on 429/5xx | `2` |
| `JEV_RECEIPTS_PATH` | JSONL receipt file | unset |

The key is resolved once, never logged, and never written to a receipt. With no
key the client fails before any network call.

Recommended for this machine: put the key in
`C:\Users\frank\.secrets\openrouter-key` and set `JEV_API_KEY_FILE` to that path.

## Surfaces

| Surface | Entry | Use |
|---|---|---|
| Library | `decide()`, `verdict()` from `src/` | code inside a workflow |
| CLI | `node jev/src/cli.mjs` | scripts, hooks, CI |
| MCP | `node jev/src/mcp.mjs` | any harness, one server |
| Skill | `skills/jev-decisions/SKILL.md` | teaches an agent when to call it |
| Tool plane | `docs/TOOL-PLANE.md` | one registration for every harness on the machine |

## Policies

`policies/*.json` hold a question template plus threshold bands. Start with
`review-gate` (merge gate), `routing` (pick a lane) and `triage` (queue
classification). Copy them rather than editing in place; calibrate bands on
labelled cases before trusting them.

## Verification

```powershell
cd jev
npm test        # node --test "tests/*.test.mjs"
node src/cli.mjs help
node src/cli.mjs check
```

`node --test jev/tests/` fails on Node 24 because the runner rejects a directory positional; the
quoted glob above is the working form. Tests never touch the network; `decide()` takes an injected
`fetchImpl`.

## Limits worth knowing

- Jev 1.13 rejects the `box` question type; image grounding starts at 1.14.
- Questions in one request are answered in parallel and cannot reference each
  other.
- A missing answer id is an error, not a `review`. Treat parse failures as
  escalations in the calling workflow.
- No streaming. A call is one request and one response.
