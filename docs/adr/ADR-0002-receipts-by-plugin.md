# ADR-0002: receipts are captured by the plugin, not by prompts

Status: accepted · 2026-10-22

## Context
"Did it happen and what did it cost?" was previously answerable only by
trusting the agent's own narration. Measured this far: 65→122k tokens of
harness context per agent-loop step, entirely invisible without automatic
capture. Instruction-based logging ("always wrap your calls") fails exactly
when it matters — busy, long, or degraded runs.

## Decision
`oms/opencode-plugin/index.ts` hooks the OpenCode event bus and writes one
receipt per agent-loop model step (model, tokens, cost, latency, finish
reason) to a local JSONL (override via `STARLIGHT_RECEIPTS_PATH`).
No agent prompt or discipline is required for honesty to exist.

## Consequences
- Weekly routing review and cost levers run on real data.
- The cost driver (context, not prompt) became visible and actionable.
- Raw event stream is kept alongside summary receipts for re-audit.

## Alternatives considered
- Prompt-level "log every call" rules — rejected: unenforceable under load.
- Post-hoc provider billing reconciliation only — rejected: no latency,
  no finish reason, no context-token breakdown.
