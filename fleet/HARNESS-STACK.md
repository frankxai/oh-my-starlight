# Starlight Harness Stack — Architecture & Naming (v1, 2026-10-21)

## The question: "now vs OmO vs OmS vs starlight-ai-harness"

These are not four competing products. They are **four layers of one stack**, and
the point of the stack is that every layer is replaceable commodity except the
ones that learn:

```
┌────────────────────────────────────────────────────────────────────┐
│ L4  starlight-ai-harness   PUBLIC TEMPLATE REPO (product for others)│
│     = L3 + playbooks + evals + setup docs, packaged                │
│     Copy-paste, one repo, zero private state                       │
├────────────────────────────────────────────────────────────────────┤
│ L3  OmS ("oh my starlight")        THE PACKAGED PLUGIN             │
│     = OmO config + routing brain + receipts + eval battery,        │
│       shipped as OpenCode/OmO plugin + repo assets                 │
│     Single SoT: routing.schema.json generates EVERYTHING           │
├────────────────────────────────────────────────────────────────────┤
│ L2  Routing brain (agentic-ops/fleet)   THE MOAT (already built)   │
│     classifier → chain → gateway/fallback → receipts               │
│     watchdog + night-cap + weekly review + eval battery            │
├────────────────────────────────────────────────────────────────────┤
│ L1  SIS (Starlight-Intelligence-System)  MEMORY AUTHORITY          │
│     vaults, restart files, telemetry, session receipts             │
├────────────────────────────────────────────────────────────────────┤
│ L0  Commodities (exchange freely, never brand them)                │
│     OpenCode · OmO plugin · Vercel Gateway · models · Claude/Codex  │
└────────────────────────────────────────────────────────────────────┘
```

### Naming contract
| Name | Means | Status |
|---|---|---|
| **"now"** (OpenCode + OmO) | Current working harness: OmO agents + routing brain + Token Pass | live |
| **OmO** | Upstream community plugin (oh-my-openagent) — commodity, we contribute config not identity | installed 5.1.40 |
| **OmS** ("oh my starlight") | OUR layer: packaging the routing brain + evals + receipts as a coherent, named harness layer on top of OmO. No fork - a plugin + assets that drive OmO | core packaged + gated (`oms/`) |
| **starlight-ai-harness** | The PUBLIC template repo containing OmS config + eval battery + playbooks, sanitized for others | scaffolded locally (`oms/export_template.py`, gate green; publish pending) |

**Rule: never build an "OmS fork" of OmO.** Commodity stays commodity. OmS owns
routing, receipts, evals, playbooks — the things that learn from our usage.

## How we measure every harness config (the only fair comparison)

Self-contained battery in `fleet/harness_eval.py` — 11 tasks, deterministic
checkers (no LLM judging), ground truth embedded:

| Task | Measures | Checker |
|---|---|---|
| `math` | multi-step reasoning | exact number |
| `puzzle` | constraint ordering | exact name |
| `instruction` | output-format obedience | exact word |
| `code` | real code generation | exec'd against 3 asserts |
| `extraction` | structured extraction, order + spelling | regex-normalized list |
| `json-format` | strict JSON output | parsed object equality |
| `date-arithmetic` | working-day date math | exact date |
| `regex` | regex authorship | compiled + executed vs fixed cases |
| `counter` | ceiling division | exact number |
| `unit-chain` | unit conversion + floor division | exact number |
| `table-filter` | filtering with deterministic order | normalized letter CSV |

**Harness axis** (now / OmS / any alternative) is measured the same way: run the
battery through each config's execution path, record results to
`fleet/evals/eval_results.jsonl` via `harness_eval.py record`, compare with
`harness_eval.py report`. A harness config is only "better" if pass rate rises
or cost/latency falls at equal pass rate.

**Hard lessons the battery caught:**
- `max_tokens` below 4000 truncates reasoning-style models to **empty answers**
  (the harness would have reported model failure for a harness bug).
- Checkers must tolerate trivial formatting variance (e.g. `B, D, E` vs
  `B,D,E`) or they measure pedantry, not capability.

**Receipts vs evals:** receipts = what happened in production (cost, latency,
fallbacks). Evals = controlled probes (quality). Together they are the model for
"does this stack actually work" — no vibes, no demos.

## Measured baseline (battery v2, 11 tasks — small n, directional only)

| rail | pass | note |
|---|---|---|
| vercel/zai/glm-5.3 (Token Pass) | 11/11 | date-arithmetic needs the full 4000-token budget; ~0.9–7.1 s/task |
| vercel/deepseek/deepseek-v4.1-flash (Token Pass) | 14/14 rows | ~0.7–6.3 s/task; nightly cron rail |
| vercel/deepseek/deepseek-v4.1-flash, 2026-10-22 full re-run (schema-priced) | 11/11 | **$0.0012/run, $34µ/pass**; rows now carry usage + cost_usd |
| opencode/beam-free | 11/11 | $0 |
| opencode/mimo-v2.6-flash-free | 2/3 recheck | answers non-empty now (old failure mode gone); date-arithmetic off by one day |
| opencode/glm-5.3-flash-free (opencode rail, plugin-captured) | 11/11 | $0; 3.5–42 s/task, mean 11.5 s (free rail is slow, not wrong) |

Directional: free tier matches the paid rails on all 11 probes so far; DS-flash
is the speed king and anchors the nightly cron. Scale n per cell to ≥10 before
trusting. Also true now: **receipts auto-capture showed the real cost driver is
harness context, not the prompt** (65k input tokens per agent step with the
Railway MCP's 71 tool schemas loaded) — tool-catalog trimming is the cost lever.

2026-10-22 red cell (characterized): **vercel/zai/glm-5.3 date-arithmetic is
currently unsteady on the gateway rail** — twice in a row it exhausted the
4000-token completion cap with empty content (`reasoning_only`), and a probe
requesting max_tokens=8000 still returned exactly 4000 (gateway-side output
cap). The same task passed for glm-5.3 the day before and for DS-flash twice
today. Leave the battery record as-is (two honest fails); this is precisely
what the graded dataset is for — a weekly_routing_review/orchestrator
proposal if it persists.

**Battery v3-seed (13 tasks)**: `task-graph` added (multi-step dependency
discipline probe (doctype, lang, viewport, alt, label-for, interactive
element via `html.parser`; no LLM judging). Seed: DS-flash pass first run.
Same day: `fleet/report_dashboard.py` renders the cross-harness report as a
self-contained tokened HTML dashboard and `--check` self-grades it
(dogfoods the discipline the battery measures). The template ships
`PLAYBOOKS.md` (build-and-grade / measure-a-model / nightly-loop recipes)
via `TEMPLATE_PLAYBOOKS` in the exporter.

## Product roadmap (phases, done = verified)

- **Phase 1 — OmS core (done 2026-10-21):** receipts auto-capture live via the
  OpenCode events plugin (`oms/opencode-plugin`, dedupe by messageID, kill
  switch `STARLIGHT_RECEIPTS=0`), battery at 11 tasks with selftest, nightly
  cron `starlight-nightly-eval` (03:30, DS-flash, full battery).
- **Phase 2 — OmS packaging (core done 2026-10-22):** package is named and
  gated — `oms/manifest.json` (index, version lives in the schema) + `oms/verify.py`
  release gate (files resolve, schema↔battery task list match, selftest, route
  smoke classify, OmO config in sync). `python oms/verify.py` = releasable check,
  all green. Public templating remains Phase 3.
- **Phase 3 — starlight-ai-harness (public scaffolding done 2026-10-22):**
  template is GENERATED, not hand-copied: `oms/export_template.py` reads
  `oms/manifest.json`, wipes the target repo (except .git), copies the package
  byte-for-byte with sanitization rewrites, and regenerates the template's own
  manifest + README + abstract `SANITIZATION.md` (rules described, never
  quoting private literals). Template passes its own `oms/verify.py` gate
  green; leak scan clean (user paths / private key labels / private repo
  names = 0 hits; `vck_` remains only as the gateway key FORMAT regex, not
  key material).
  Export also caught a real dep the source gate couldn't see (route_classifier/
  route_executor missing from the manifest). Local scaffold only — no remote,
  publish is Frank's call. Playbooks (build-a-website, build-a-product, run-
  an-experiment) stay a later addition, not a blocker.
- **Phase 4 - cross-harness comparison (first slice done 2026-10-22):** same
  battery, compared across execution rails. `fleet/cross_harness.py` joins
  evals/eval_results.jsonl (quality per rail+model) with
  receipts/opencode.jsonl (per-message cost/latency/context weight) and writes
  reports/cross-harness-latest.md + .json - deterministic, no model calls.
  `fleet/run_opencode.py` seeds the plugin rail: `opencode run` -> the same
  deterministic checkers -> `record --harness opencode-plugin`; receipts are
  auto-captured by the plugin. First seed: glm-5.3-flash-free 11/11 at $0
  through the opencode rail. The receipts table quantifies the harness-context
  thesis (mean cache-read 117k tokens on opencode at $0 free tier). Scale up n
  per rail+model cell grows nightly: `fleet/nightly_eval.py` (night-cap gate ->
  gateway rail -> free opencode rail only when free RAM >= 4 GiB -> report);
  activating it on the registered task is one approved schtasks argument swap
  (GATE). Gateway rows now carry usage tokens + schema-priced cost_usd
  (DS-flash 11/11 at $0.0012/run, $34µ/pass); cross_harness emits cost-per-pass
  plus a fails-only task matrix; proposals flow through weekly_routing_review
  as always.

## Doctrine
- Same battery for everything. Same rules for everything.
- If it didn't produce receipts or eval rows, it didn't happen.
- Commodities never get rebranded. OmS is the learning layer, nothing else.
