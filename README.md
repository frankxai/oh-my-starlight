# oh-my-starlight (OmS)

The Starlight routing brain as a package: model routing schema (single
source of truth), a 13-task deterministic eval battery, automatic receipts
of every agent-loop model call, spend caps + night gates, OmO bars
(owner != verifier, machine-graded), and the architecture docs
(HARNESS-STACK, ROUTING-BRAIN, ADRs).

This is the dependency home - star it, depend on it, PR into it.
For a fresh start, fork the template instead:
[starlight-ai-harness](https://github.com/frankxai/starlight-ai-harness).

## Install path

Stdlib only, no dependencies. Python 3.11+.

```bash
python oms/verify.py                     # gate: files, schema<->battery, selftest
python fleet/route_task.py "review this PR"
python fleet/harness_eval.py selftest
```

## What's inside (beyond the template)

Everything in `oms/manifest.json`, plus the two architecture docs the
template excludes (`fleet/HARNESS-STACK.md`, `fleet/ROUTING-BRAIN.md`)
and the decision records in `docs/adr/`.

## Provenance

Exported from the private source of truth by `oms/export_template.py`
(`--package-target`), sanitized. Regenerate, never hand-edit.
See `SANITIZATION.md`.
