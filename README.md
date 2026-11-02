# oh-my-starlight (OmS)

**Measured model routing for coding-agent harnesses.** Instead of routing
tasks to models by vibes, route by evidence: a deterministic eval battery
grades every model on real work, receipts capture what each call cost and
how it performed, and a weekly review turns both into routing proposals a
human approves. Measure, remember, propose, evolve - all gated, all
reproducible.

This is the **package home** - star it, depend on it, PR into it.

## The flywheel

1. **Measure** - a 22-task deterministic eval battery (no LLM judging:
   checkers exec real code, run real asserts, reject real slop) grades
   every candidate model on a task class before it routes traffic
2. **Remember** - `memory_bridge.py` distills the graded rows into
   per-model memory cards (pass rate, strong/weak tasks, $/pass) that feed
   the weekly review - proposals cite receipts *and* battery memory
3. **Propose** - `weekly_routing_review.py` proposes routing diffs with
   the evidence attached; humans approve, nothing auto-commits
4. **Evolve** - applied proposals land in `routing.schema.json` (single
   source of truth) and the whole surface regenerates from it

## What's inside

- **routing.schema.json** - single source of truth: task classes, model
  chains and fallbacks, spend caps, eval battery def, receipts config
- **harness_eval.py** - the 22-task battery: math, puzzle, instruction,
  code, extraction, json-format, date-arithmetic, regex, counter,
  unit-chain, table-filter, html-design, task-graph, debug-repair,
  tool-use, keyfacts, multi-step-plan, config-audit - deterministic
  checkers only
- **route_task.py / route_classifier.py / route_executor.py** - classify
  a task, resolve its chain, record the receipt
- **gateway_call.py** - gateway caller with 403-catch fallback walking
- **weekly_routing_review.py** - receipts + memory cards -> routing diff
  proposals (both planes cited)
- **memory_bridge.py** - graded rows -> per-model memory cards
- **omo_bridge.py** - machine-grade an OmO `SUCCESS.md` bar: every
  criterion needs an author check plus a verifier distinct from the
  owner; `check:` tags must resolve to real battery checkers
- **credit_watchdog.py / night_cap_check.py** - spend guardrails
- **oms/opencode-plugin/** - auto-captures one receipt per agent-loop
  model step (model, tokens, cost, latency, finish) via OpenCode events
- **oms/verify.py** - package release gate: run before trusting anything
- **HARNESS-STACK.md / ROUTING-BRAIN.md / docs/adr/** - the architecture
  docs and decision records the template excludes

## Install path

Stdlib only, no dependencies. Python 3.11+.

```bash
git clone https://github.com/frankxai/oh-my-starlight
cd oh-my-starlight
python oms/verify.py                     # gate: files, schema<->battery, selftest
python fleet/route_task.py "review this PR"
python fleet/harness_eval.py selftest
python fleet/harness_eval.py run-gateway --model <your/model>
```

Wire the auto-capture plugin in your global OpenCode config:

```jsonc
{ "plugins": ["<absolute path to this repo>/oms/opencode-plugin"] }
```

## Three-tier topology

| Repo | Role | Your move |
|---|---|---|
| [oh-my-starlight](https://github.com/frankxai/oh-my-starlight) (this) | package: dependency home | star / depend / PR |
| [starlight-ai-harness](https://github.com/frankxai/starlight-ai-harness) | template: fork surface | fork for a fresh start |
| [harness-registry](https://github.com/frankxai/harness-registry) | cross-CLI index | check the measurements |

## Provenance

Exported from the private source of truth by `oms/export_template.py`
(`--package-target`), sanitized at source. Regenerate, never hand-edit.
See `SANITIZATION.md`.

## License

MIT - see [LICENSE](LICENSE).
