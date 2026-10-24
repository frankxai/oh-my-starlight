# ADR-0006: maker and verifier are separate heads, merges stay human

Status: accepted · 2026-10-22

## Context
Agent-built code graded by the same agent in the same context misses its
own mistakes. Meanwhile the highest-consequence actions (merges, deploys,
publishes, spend beyond caps, secret handling, bulk delete) were observed
to need exactly the accountability structure reviews provide.

## Decision
Permission classes are split deliberately:
- build: inline, autonomous within a branch, committed with gates green
- verify: separate mechanism, not the maker's narration — self-grade
  (`--check`), deterministic battery, and gate scripts
- risky (merge to main, publish, schtasks changes, ledger splices,
  pushes): prepared to ready-state, then executed only in one human batch
  (the GATE chain)

## Consequences
- The build loop runs as far as evidence reaches; no further.
- Frank's button covers the actions with real-world impact, batched —
  this is the efficiency that makes "always gated" affordable.

## Alternatives considered
- Fully autonomous merge — rejected: observed monitor/coder divergence
  (stale checkout dropped a committed block) argues for a human gate.
- Verify by the maker only — rejected: same-context blindness.
