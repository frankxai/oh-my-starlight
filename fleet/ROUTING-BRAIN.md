# Starlight Routing Brain (v5)

Self-improving, cost-aware model router for the Starlight sovereign agent estate.

## Files

| File | Purpose |
|---|---|
| `routing.schema.json` | Single source of truth: task classes → model chains, Token Pass pricing, cost ceilings, ZDR flags |
| `gen_omo_config.py` | Generates `~/.omo/omo.jsonc` from the schema (run after editing schema) |
| `route_classifier.py` | Classifies a task prompt into a routing class (regex fast-path + heuristic) |
| `route_executor.py` | Decision layer: model + fallback chain; atomic+locked receipt append |
| `route_task.py` | One-shot CLI: classify + route (+ optional receipt recording) |
| `gateway_call.py` | Live gateway caller with 403-catch fallback walking; receipts per attempt |
| `credit_watchdog.py` | Monitors Token Pass spend per key; soft $60 / hard $78 alerts (exit 1/2) |
| `night_cap_check.py` | Spend gate for unattended runs; fails above `night_cap_usd` |
| `weekly_routing_review.py` | Parses receipts, proposes routing diffs (human approval, never auto-commit) |

## Scheduled tasks (Windows, user-level)

| Task | Schedule | Runs |
|---|---|---|
| `starlight-credit-watchdog` | hourly | `credit_watchdog.py` → `receipts/watchdog_last.json` |
| `starlight-nightly-eval` | daily 03:30 | `harness_eval.py run-gateway` (11 tasks, deepseek-v4.1-flash) → `evals/eval_results.jsonl` |
| `starlight-weekly-routing-review` | Sun 04:00 | `weekly_routing_review.py` → `routing-proposals/` |

Remove with `schtasks /Delete /TN <task> /F`.

## Usage

```bash
# Classify + route a task
python route_task.py "refactor the auth module and add tests"

# Record a receipt after the call completes
python route_task.py "refactor the auth module" --record success \
  --used vercel/zai/glm-5.3 --cost 0.0002 --latency 1500 --provider token-pass

# Live gateway call with automatic 403 fallback walking
python gateway_call.py code "refactor the loop below"
# Test the walker without burning quota: STARLIGHT_FORCE_FAIL_N=1 fails the first attempt

# Check Token Pass credit health (exit 0 ok / 1 soft / 2 hard)
python credit_watchdog.py

# Night-run spend gate (wire into night_runner validation)
python night_cap_check.py --extra-planned-usd 15   # exit 2 if above night_cap_usd

# Regenerate OmO config after editing routing.schema.json
python gen_omo_config.py

# Weekly review (scheduled Sundays 04:00; run manually any time)
python weekly_routing_review.py

# Model battery (11 tasks, deterministic checkers; manual anytime)
python harness_eval.py run-gateway --model vercel/deepseek/deepseek-v4.1-flash
python harness_eval.py selftest   # verify checkers, no model calls
python harness_eval.py report
```

## Task classes

| Class | Primary | Cost ceiling | ZDR | Use for |
|---|---|---|---|---|
| scout | mimo-v2.6-flash-free | $0 | no | exploration, search, mapping |
| review | deepseek-v4.1-flash-free | $0 | no | code review, lint, style |
| bulk | vercel/deepseek/deepseek-v4.1-flash | $0.05 | yes | high-volume extraction |
| code | vercel/zai/glm-5.3 (medium) | $0.50 | yes | everyday coding, edits |
| hard-reasoning | vercel/moonshotai/kimi-k3 (high) | $2.00 | yes | complex reasoning, deep codegen |
| vision | nemotron-3.5-super-vl-free | $0 | no | multimodal analysis |
| ultrabrain | vercel/moonshotai/kimi-k3 (max) | $5.00 | yes | hardest tasks |

## Guardrails

- Free tier first; Token Pass only for bulk/code/hard-reasoning/ultrabrain.
- Cost ceiling enforced per class in `record_receipt`.
- Used model must be in the chain (off-chain models rejected).
- Receipts are append-only JSONL under `receipts/routing.jsonl`.
- Proposals require human approval; never auto-commit.

## Token Pass credit

Team: <your-team>. **Four keys, each with its own $80/month quota — $320/month total**:
<key-1> (new, wired into `opencode.json`), <key-2>, <key-3> (old), <key-4>.
Soft alert at $60/key (`credit_watchdog.py`), hard 403 at $80/key. No rollover.

## Doctrine

- Use commodities (OpenCode, OmO, Vercel, OpenRouter), build the moat (this).
- Done = verified. Every phase ships a runnable proof.
- Money/merges/deployments stay on the human's button.
