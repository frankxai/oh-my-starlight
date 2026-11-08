# Registering Jev on the shared tool plane

The plane at `127.0.0.1:7317` pools one child per backend for every harness on
the machine. Registering Jev there gives OpenCode, Claude, Codex and Grok the
same three tools from one process instead of four.

## What the plane requires

From `ops/shared-tool-plane.policy.json` (schema
`starlight.shared-tool-plane.policy.v2`), every backend must be:

- `"kind": "stdio"` and `"singleton": true`
- launched through a resolved script path, not an `npx` shim (cold `npx` resolve
  blew the connect timeout for context7 and took the whole plane down)
- admitted tool by tool via `allowTools`, with a `rationale`
- `"policy": "read-only"`. The plane stamps every exposed tool
  `readOnlyHint: true`, so a backend that writes inside the call is a silent
  policy violation.

Jev's three tools only read a remote decision API, so they fit. Receipts are a
local append, so they stay **off** the plane: do not set `JEV_RECEIPTS_PATH` in
the backend entry. Write receipts from the CLI or from the calling workflow.

## Backend entry

Add to the `backends` array:

```jsonc
{
  "id": "jev",
  "kind": "stdio",
  "singleton": true,
  "command": "node",
  "script": "C:\\Users\\frank\\starlight\\repos\\oh-my-starlight\\jev\\src\\mcp.mjs",
  "args": [],
  "namespace": "jev",
  "policy": "read-only",
  "toolTimeoutMs": 30000,
  "allowTools": ["jev_decide", "jev_check", "jev_policies"],
  "rationale": "Typed decisions for every harness from one pooled child. Read-only against a remote Decisions API; no local writes, no secrets in responses. Replaces per-harness prompt-and-parse classification with a calibrated number."
}
```

Set the key for the backend process, not in the policy file. Either export
`JEV_API_KEY_FILE` in the plane's environment or point `JEV_API_KEY_FILE` at
`C:\\Users\\frank\\.secrets\\openrouter-key`.

## Where to edit

The live plane reads `ops/shared-tool-plane.policy.json` **inside the active
release**, currently:

```
C:\Users\frank\.starlight\tool-plane\releases\2.0.0-0b688c90b106
```

That directory is a release artifact. `install-manifest.json` pins a sha256 per
file, and the source of truth is:

```
C:\Users\frank\starlight\worktrees\starlight-command-center-agent-ops-plane\apps\observatory
```

So the durable change is: edit the policy in that source worktree, rebuild the
release, then activate it. Hand-editing the release file works immediately but
breaks the manifest hash and is lost on the next release.

`STARLIGHT_TOOL_PLANE_POLICY` overrides the policy path entirely, which is the
safe way to trial a second policy file without touching the active release.

## Apply and verify

```powershell
# 1. validate the JSON before restarting anything
node -e "const p=require('C:/Users/frank/.starlight/tool-plane/releases/2.0.0-0b688c90b106/ops/shared-tool-plane.policy.json'); console.log(p.backends.map(b=>b.id).join(','))"

# 2. restart the plane (Task Scheduler owns it; the launcher is idempotent)
C:\Users\frank\.starlight\tool-plane\run-plane.cmd

# 3. read status and confirm the backend is ready with 3 exposed tools
Get-Content C:\Users\frank\.starlight\tool-plane\status.json -Raw

# 4. call it once through the plane
opencode api post /mcp --data '{}'   # or use the plane tools from any harness
```

Success looks like a `jev` entry in `status.json` with `"state": "ready"`,
`"exposedTools": 3`, `"allowedTools": 3` and `"contractVerified": true`. A
`contractVerified: false` or a `failedCalls` increment means the tool schemas
did not validate; check that every `jev_*` input schema has `type: "object"`,
the failure mode that quarantined `sbo-brain-files`.

## Rollback

Remove the `jev` entry from `backends` and restart. The plane drops the child on
the next idle sweep. No other backend is affected, and the CLI and per-harness
registration keep working independently.
