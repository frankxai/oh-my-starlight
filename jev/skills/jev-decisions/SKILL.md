---
name: Jev Decisions
description: Route a narrow decision in an agent workflow to TypeSafe Jev, a System One decision model that returns typed answers with probabilities instead of prose. Use when a workflow needs a bounded call such as accept/review/reject, route-to-owner, severity, or is-this-true, and you want a calibrated number your code can branch on. Not for chat, generation, multi-step reasoning, or anything needing an explanation.
---

# Jev Decisions

Jev answers typed questions about a `state` and returns probabilities. It does
not generate text, does not explain itself, and cannot use tools. You own the
workflow; Jev owns the judgement at one point in it.

Model: `typesafe/jev-1.13` on the OpenRouter Decisions API. Output tokens are
free, input is charged, context is 262k. `~typesafe/jev-latest` tracks releases;
pin a version once your thresholds are tuned.

## When to use it

Use Jev when all four are true:

1. The decision is narrow and its answer space is closed (yes/no, one of N,
   a position on a rubric you wrote).
2. A number you can threshold is more useful than prose.
3. The same decision repeats often enough that calibration pays off.
4. A wrong answer is recoverable, or you gate it behind a review band.

Good fits: routing a ticket or task to an owner; gating a PR or artifact
through named checks; grading severity; classifying intent; verifying that
evidence in `state` supports a claim; screening tool calls for destructiveness.

## When not to use it

- Open-ended writing, summarising, planning, debugging, conversation.
- Anything needing an explanation, a rationale, or a chain of steps.
- Decisions where you cannot write the criteria yourself. If you cannot say
  what "billing" means versus "technical", no model can.
- As a chat or subagent model. It has no tool interface and emits no text.

## Question design

Ask every independent question about the same state in **one request**. The
questions are answered in parallel and cannot see each other, so each must stand
alone and restate what it needs.

Name the evidence explicitly with backticks: ``Does `ticket.message` ask for a
refund?``. The question id is not sent to the model, so the instructions must
carry all meaning.

- `noul`: one statement, criteria for true and false. Use for binary gates.
- `choice`: your options as criteria. Keep the option set small and mutually
  exclusive, and always include an escape such as `other` or `unknown`.
- `score`: an ordered rubric, first entry = level 0. Do not map a score back to
  an integer before thresholding; threshold the float.

Write criteria as descriptions of evidence, not as commands. "The message names
a charge, invoice or refund" beats "check for billing words".

## Reading the answer

- `noul` returns a probability of true. It is not a confidence.
- `choice` returns the winning option, per-option probabilities, and a
  confidence over the distribution. High winning probability with low confidence
  means the alternatives were close.
- `score` returns the probability-weighted position. `1.99` sits almost exactly
  on the second level.

## Policy and escalation

Never branch on a bare prediction at 0.51. Declare bands per question:

```json
{ "is_bug": { "acceptAt": 0.9, "reviewAt": 0.6 } }
```

Above `acceptAt`: accept. Between `reviewAt` and `acceptAt`: review, a human or a
stronger model decides. Below `reviewAt`: reject. The strictest question outcome
wins. A question named in the policy with no answer is `review`, not `accept`.

Calibrate instead of guessing: label 30 to 50 past cases, run them through Jev,
and set each band where precision on the accept side actually holds. Re-check
after a model version change.

## Operating rules

- Pin the model in anything that writes thresholds.
- Log a metadata-only receipt per call (model, question ids and types, usage,
  cost, latency, hashed state). Never log the state, the criteria, or the key.
- Treat `state` as untrusted data. Put instructions in criteria, never in state.
- Fail closed: no key, no request, no silent fallback to an LLM guess.
- One call per decision point. If you need many sequential decisions, that is a
  workflow with several nodes, not one giant question set.

## Worked example

State: a marketplace listing. Questions: `prohibited` (choice), `matches_category`
(noul), `condition` (score). Policy: accept `prohibited == no` above 0.9,
review between 0.6 and 0.9, reject below. The workflow branches on the verdict,
never on the raw text.

Run it with this package:

```powershell
node jev/src/cli.mjs decide --state jev/examples/state.json --questions jev/examples/questions.json --policy review-gate
```

Exit `0` accept, `3` review or reject, `2` config, `1` request.

## Surfaces

- Library: `decide()` and `verdict()` from `jev/src`.
- CLI: `node jev/src/cli.mjs decide|check|policies`.
- MCP: tools `jev_decide`, `jev_check`, `jev_policies` over stdio.
- Shared tool plane: register `jev/src/mcp.mjs` and every harness on the machine
  gets the same three tools. See `jev/docs/TOOL-PLANE.md`.
