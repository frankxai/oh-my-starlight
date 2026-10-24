# ADR-0004: RAM floor of 4 GiB gates worker-class rails

Status: accepted · 2026-10-22

## Context
The workstation runs 2.1 GiB free most of the day. Free-tier OpenCode rails
(spawn CLI sessions per task) and browser QA thrashed the machine when
treated as free. The nightly orchestrator needed an unattended-safe rule
comparable across any hour of the day.

## Decision
- This machine: run worker-class rails (OpenCode CLI sessions, browsers,
  subagent swarms) only when free RAM ≥ 4 GiB (GlobalMemoryStatusEx floor).
- The gateway rail (urllib one-shot, no workers) is the proven-safe class —
  batteries, reports, and page builds run regardless of the floor.
- `nightly_eval.py` self-skips the free rail under the floor and records the
  SKIP: redacted capacity, not lost measurement.

## Consequences
- The harness stays honest at machine pressure instead of degrading it.
- Free-tier measurement happens in the RAM window, nightly or on demand.

## Alternatives considered
- Always run and hope — rejected: observed thrash at 2.1 GiB.
- Hard-code "never free rails" — rejected: wastes proven $0 capacity
  when the machine has room.
