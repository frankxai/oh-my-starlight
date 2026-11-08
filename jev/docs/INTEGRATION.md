# Wiring Jev into a workflow

Three steps, in this order: register the surface, add the routing rule, then
attach a verdict to a branch.

## 1. Pick the surface

**Shared tool plane (recommended, one registration for every harness).**
Follow `docs/TOOL-PLANE.md`. After the plane restarts, `jev_decide`,
`jev_check` and `jev_policies` are visible to OpenCode, Claude, Codex and Grok
without touching any per-harness config.

**Per harness.** Each harness takes a stdio MCP server entry.

OpenCode, `C:\Users\frank\.config\opencode\opencode.json`:

```jsonc
{
  "mcp": {
    "jev": {
      "type": "local",
      "command": ["node", "C:/Users/frank/starlight/repos/oh-my-starlight/jev/src/mcp.mjs"],
      "enabled": true
    }
  }
}
```

Claude Code, `.mcp.json` in the project or the user config:

```jsonc
{
  "mcpServers": {
    "jev": {
      "command": "node",
      "args": ["C:/Users/frank/starlight/repos/oh-my-starlight/jev/src/mcp.mjs"]
    }
  }
}
```

Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.jev]
command = "node"
args = ["C:/Users/frank/starlight/repos/oh-my-starlight/jev/src/mcp.mjs"]
```

Config edits reload without a restart in OpenCode. Claude and Codex need their
session restarted to pick up a new server.

## 2. Add the routing rule

Paste this into the repo's `AGENTS.md` or `CLAUDE.md`. Without it the agent will
keep prompting its own model for classifications.

```markdown
## Decisions

When a task reduces to a bounded judgement with a closed answer space
(accept/review/reject, route-to-owner, severity, is-this-true), call the `jev`
MCP server instead of deciding inline. Ask all independent questions in one
`jev_decide` call, pass `policy` to get a verdict, and branch on
`verdict.decision`. Do not use Jev for generation, explanation, planning or
anything needing tools. If the tool is unavailable or returns an error, escalate
to review; never substitute a guess.
```

## 3. Attach a verdict to a branch

The unit of integration is a node in a workflow, not a conversation turn.

```js
import { decide } from "../jev/src/client.mjs";
import { verdict } from "../jev/src/questions.mjs";
import policy from "../jev/policies/review-gate.json" with { type: "json" };

const result = await decide({ state, questions: policy.questions, receiptsPath: "jev/receipts/2026-11.jsonl" });
const gate = verdict(result, policy.policy);

if (gate.decision === "accept") return merge();
if (gate.decision === "review") return requestHumanReview(gate.reasons);
return block(gate.reasons);
```

Loop shape (`loop-system` contracts): make the Jev call a **judge** node between
`build` and `ship`. The loop's stop condition becomes `verdict.decision ===
"accept"`, the iteration budget covers the review band, and `reject` exits the
loop with a named reason instead of retrying blindly.

Graph shape: the decision node has three outbound edges, one per verdict, and
carries the receipt id as edge metadata so a run can be replayed.

## Calibration, once per decision type

1. Collect 30 to 50 historical cases with known outcomes.
2. Write the questions so the criteria are evidence descriptions.
3. Run them all through `decide()` with receipts on.
4. Plot accepted cases against ground truth. Set `acceptAt` where precision on
   the accept side is the precision you need, and `reviewAt` where the review
   volume is affordable.
5. Re-run the set after any model version change before trusting the bands.

Never tune a band on the same cases you report results from.

## Cost

Billed on input only. A three-question call on a 1.5k-token state is roughly
1.5k to 2k input tokens, so at `$0.042 / 1M` that is under `$0.0001` per call.
Receipts record the exact `usage.cost`. One call per decision point, many
questions per call, keeps this negligible next to the LLM work it guards.

## Failure semantics

| Failure | Behaviour | Caller should |
|---|---|---|
| No API key | `JevConfigError`, no request made | fail the workflow, fix config |
| 429 or 5xx | retried with backoff, then `JevRequestError` | escalate to review |
| Timeout | `JevRequestError`, `details.reason = "timeout"` | escalate to review |
| Missing answer id | `JevParseError` | escalate to review |
| Answer outside `[0,1]` | `JevParseError` | escalate to review |

A decision model that silently degrades to an LLM guess is worse than no decision
model. Keep the escalation path loud.
