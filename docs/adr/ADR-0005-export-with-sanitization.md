# ADR-0005: the public template is regenerated with sanitization, never hand-copied

Status: accepted · 2026-10-22

## Context
A public template carrying private architecture docs, key labels, or
absolute paths is a leak waiting for momentum. Hand-copying also drifts:
the template README advertised `report_dashboard.py` a build after the
manifest stopped carrying it.

## Decision
`oms/export_template.py` is the only path from private package to public
template:
- deletes everything except `.git`, re-copies from the manifest
- applies declared `SANITIZATION_RULES` byte-for-byte (key labels, paths)
- excludes private docs by name (`TEMPLATE_EXCLUDE_DOCS`)
- regenerates manifest, README, SANITIZATION.md, PLAYBOOKS.md from code
- parity checked by `verify.py` after export

## Consequences
- "Regenerate, never hand-edit" is enforced by tooling, not memo.
- Excluded-by-design and drifting-inclusion are the same explicit list.

## Alternatives considered
- Submodule/share directly — rejected: no sanitization seam.
- GitHub Actions exporter — rejected: private machine is the SoT for now.
