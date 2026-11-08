# Jev decision layer: build contract

Fixed interfaces. Every lane implements against this file and does not redefine
these shapes. If something here is wrong, say so in the lane report instead of
silently diverging.

Runtime: Node >= 20, ESM (`.mjs`), zero runtime dependencies for the core and
the CLI. Only `src/mcp.mjs` may import `@modelcontextprotocol/sdk`, and it must
fail with an install instruction when the package is absent.

## Files and owners

| Path | Owner lane |
|---|---|
| `jev/package.json`, `jev/src/config.mjs`, `jev/CONTRACT.md` | orchestrator (done) |
| `jev/src/questions.mjs`, `jev/src/client.mjs`, `jev/tests/client.test.mjs`, `jev/tests/questions.test.mjs` | lane A |
| `jev/src/cli.mjs`, `jev/src/mcp.mjs`, `jev/tests/cli.test.mjs`, `jev/tests/mcp.test.mjs`, `jev/docs/TOOL-PLANE.md` | lane B |
| `jev/skills/jev-decisions/SKILL.md`, `jev/docs/INTEGRATION.md`, `jev/README.md`, `jev/policies/*.json`, `jev/examples/state.json`, `jev/examples/questions.json` | lane C |

## Public API

`src/client.mjs`

```js
export async function decide(request, options = {}) -> DecisionResult
```

- `request = { state, questions, model?, route?, apiKey?, baseUrl?, timeoutMs?, maxRetries?, receiptsPath? }`
- `options = { fetchImpl?, now?, receiptWriter? }` for tests.
- `state` is a string, object or array. Reject `null`, `undefined`, empty string and empty object.
- `questions` is a non-empty plain object of `id -> question`. Reject arrays, empty maps, and any question whose `type` is not `noul`, `choice` or `score`.
- Missing API key throws `JevConfigError` **before** any network call.
- HTTP 429 and 5xx retry up to `maxRetries` with exponential backoff (250 ms base). 4xx other than 429 throws immediately.
- Timeout uses `AbortSignal.timeout(timeoutMs)` and surfaces as `JevRequestError` with `details.reason === "timeout"`.

`DecisionResult`

```js
{
  ok: true,
  requestId: string | null,
  model: string,          // as reported by the API when present
  route: "decisions" | "systemone",
  answers: {
    [questionId]: {
      type: "noul",
      noul: number
    } | {
      type: "choice",
      choice: string,
      probabilities: { [option: string]: number },
      confidence: number
    } | {
      type: "score",
      score: number,
      confidence: number
    }
  },
  usage: { inputTokens: number | null, outputTokens: number | null, costUsd: number | null },
  latencyMs: number,
  raw?: object           // present only when request.includeRaw === true
}
```

Normalisation rules:
- Accept `usage` in either shape: `{ input_tokens, output_tokens, cost }` or `{ inputTokens, outputTokens, costUsd }`.
- Accept `answers` values that omit `type` by inferring from the key present (`noul` / `choice` / `score`).
- Never invent an answer for a question id the API did not return; missing ids are a `JevParseError`.
- Numeric answers must be finite numbers in `[0, 1]` for `noul`, and finite for `score`.

`src/questions.mjs`

```js
export function noul(instructions, criteria) -> question
export function choice(instructions, criteria) -> question   // criteria: string[] | { [option]: string }
export function score(instructions, criteria) -> question     // criteria: string[] (ordered) | { levels: string[] }
export function noulTrue(answer, threshold = 0.5) -> boolean
export function verdict(result, policy) -> Verdict
```

`Verdict` shape (this is what workflows and loops branch on):

```js
{
  decision: "accept" | "review" | "reject",
  reasons: string[],                  // question ids that forced the decision
  questions: {
    [id]: { action: "accept" | "review" | "reject", value: number | string, confidence?: number }
  }
}
```

Policy shape accepted by `verdict()` (flat map):

```js
{
  questionId: { acceptAt: 0.9, reviewAt: 0.6 }   // noul
  questionId: { acceptWhen: ["billing"], reviewWhen: ["other"] }  // choice
  questionId: { acceptAt: 1.5, reviewAt: 0.9 }   // score
}
```

Policy **files** under `jev/policies/` are documents: `{ id, description, model, notes,
questions, policy }`. The `policy` key holds the flat map above; `questions` is a template.
`loadPolicy()` in the CLI normalises both the document form and a bare flat map, and must
never pass `id`/`notes`/`description` to `verdict()` as if they were question ids.

Rules: the strictest question outcome wins (`reject` > `review` > `accept`).
An id in the policy with no matching answer is `review` with reason
`missing:<id>`. A policy with no entries returns `accept` and reason `no-policy`.

## CLI

`node src/cli.mjs <command>`

- `decide --state <path|-> --questions <path|-> [--policy <id>] [--model <id>] [--route decisions|systemone] [--receipts <path>] [--include-raw]`
- `check` prints `describeConfig()` plus a `ready` boolean. No network call.
- `policies` lists `policies/*.json` with `id` and `description`.
- `help` / `--help` prints usage.

stdout is one JSON document. stderr is human diagnostics. Exit codes:
`0` accept, `3` review or reject (escalation), `2` usage or config error,
`1` request or parse error.

## MCP server

`node src/mcp.mjs`, stdio transport, server name `jev`, version from package.json.

Tools (all read-only, no filesystem writes). Every tool definition carries
`annotations: { readOnlyHint: true }`, and every `inputSchema` has `type: "object"`
(the shared tool plane rejects a backend whose schema is not an object).

- `jev_decide` input `{ state, questions, model?, route?, policy? }`, returns the
  `DecisionResult` plus `verdict` as JSON text.
- `jev_check` no input, returns `describeConfig()` plus `ready`.
- `jev_policies` no input, returns the policy index.

Missing key must produce a tool error with the remediation text, never a crash.
`src/mcp.mjs` exports `createServer()` and `TOOL_DEFINITIONS` so tests can assert
both without spawning a transport.

## Verification each lane must run

```
node --test jev/tests/<own test files>
node jev/src/cli.mjs help
```

Lane B additionally: `node -e "import('./jev/src/mcp.mjs').then(m=>console.log(Object.keys(m)))"`.

No network calls in tests. Inject `fetchImpl`.
