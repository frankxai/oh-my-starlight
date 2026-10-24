# ADR-0001: routing.schema.json is the single source of truth

Status: accepted · 2026-10-22

## Context
Routing behavior (model chains, spend caps, token pricing, the eval battery
definition, receipts config) was at risk of drifting across scripts, crons,
and hand-edited configs. Every drift we caught this far (cron args vs
orchestrator, README vs manifest, battery count vs schema) was a second
copy of the same truth.

## Decision
One file — `fleet/routing.schema.json` — is the SoT. Everything else is
generated from or validated against it:
- OpenCode plugin config via `gen_omo_config.py`
- battery lists via `verify.py` parity check (schema ↔ harness_eval TASKS)
- pricing in eval rows comes from schema `token_pass.models`, never invented
- template export reads the same manifest/SoT; sanitization is declared in
  one place (`export_template.py`)

## Consequences
- Changing routing means one commit in one file; generated outputs refresh.
- `verify.py` fails closed on parity drift instead of warning.

## Alternatives considered
- YAML/env config per script — rejected: N copies of truth again.
- Database/registry — rejected: stdlib + git diffability is the estate
  baseline for reviewable machine doctrine.
