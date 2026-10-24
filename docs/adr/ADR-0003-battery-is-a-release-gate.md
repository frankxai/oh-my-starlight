# ADR-0003: the eval battery is a release gate, not a report

Status: accepted · 2026-10-22

## Context
Model choices were previously reputation-based. A reputation call nearly
steered estate work to glm-5.3 the same week it unsteadily failed its
flagship task class twice (4000-token cap exhaustion). Only a persisted,
priced, deterministic battery made that untrustworthiness visible in two
rows instead of two weeks.

## Decision
`verify.py` ties schema ↔ battery ↔ checker selftest into the package gate:
- parity: schema `eval_battery.tasks` == `harness_eval.TASKS` keys
- selftest: every checker passes a canned ground-truth AND rejects a
  known-slop input (html-design negative case)
- nightly: `nightly_eval.py` runs the battery through the night-cap gate
  and appends priced rows to the ledger

## Consequences
- Fails are recorded honestly, never hidden; red cells are the routing
  signal, not embarrassments to fix in the data.
- A model change is evidence, not a discussion.

## Alternatives considered
- LLM-judge scoring — rejected: non-deterministic, self-flattering.
- Manual spot-checks per session — rejected: unmeasurable, drift.
