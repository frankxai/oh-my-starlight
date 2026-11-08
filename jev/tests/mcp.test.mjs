// MCP surface tests. No transport, no network, no SDK required for the tool
// definitions or the tool handlers; the SDK assertions skip with a clear reason
// when the optional dependency is genuinely not installed.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MCP_SDK_MISSING_MESSAGE,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_DEFINITIONS,
  callTool,
  createServer,
  loadSdk,
} from "../src/mcp.mjs";
import { JevRequestError } from "../src/config.mjs";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = resolve(TESTS_DIR, "../src/mcp.mjs");

const ENV_KEYS = ["JEV_API_KEY", "JEV_API_KEY_FILE", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "JEV_BASE_URL", "JEV_MODEL"];

function isolateEnv(overrides = {}) {
  const saved = new Map();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function withEnv(env, fn) {
  const restore = isolateEnv(env);
  try {
    return await fn();
  } finally {
    restore();
  }
}

function parseContent(toolResult) {
  assert.ok(Array.isArray(toolResult.content), "tool result has content[]");
  assert.equal(toolResult.content[0].type, "text");
  return JSON.parse(toolResult.content[0].text);
}

const DECISION_RESULT = {
  ok: true,
  requestId: "req-mcp-1",
  model: "typesafe/jev-1.13",
  route: "decisions",
  answers: { gate: { type: "noul", noul: 0.33 } },
  usage: { inputTokens: 90, outputTokens: 4, costUsd: 0.0002 },
  latencyMs: 640,
};

test("TOOL_DEFINITIONS exposes exactly the three contracted tools", () => {
  assert.deepEqual(
    TOOL_DEFINITIONS.map((tool) => tool.name),
    ["jev_decide", "jev_check", "jev_policies"],
  );

  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} schema must be an object`);
    assert.equal(typeof tool.inputSchema.properties, "object");
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must declare annotations.readOnlyHint`);
  }

  const decide = TOOL_DEFINITIONS.find((tool) => tool.name === "jev_decide");
  assert.deepEqual(decide.inputSchema.required, ["state", "questions"]);
  assert.ok(decide.inputSchema.properties.state);
  assert.ok(decide.inputSchema.properties.questions);
  assert.ok(decide.inputSchema.properties.policy, "policy is optional but declared");

  for (const name of ["jev_check", "jev_policies"]) {
    const tool = TOOL_DEFINITIONS.find((entry) => entry.name === name);
    assert.deepEqual(tool.inputSchema.properties, {});
    assert.equal(tool.inputSchema.required, undefined);
  }
});

test("all three tools declare annotations.readOnlyHint === true", () => {
  assert.equal(TOOL_DEFINITIONS.length, 3);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(
      tool.annotations?.readOnlyHint,
      true,
      `${tool.name} must carry annotations.readOnlyHint: true`,
    );
  }
});

test("server identity comes from package.json", () => {
  assert.equal(SERVER_NAME, "jev");
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+/);
});

test("jev_check reports ready:false without a key and does not error", async () => {
  const result = await withEnv({}, () => callTool("jev_check", {}));

  assert.notEqual(result.isError, true);
  const payload = parseContent(result);
  assert.equal(payload.ready, false);
  assert.equal(payload.key.present, false);
  assert.equal(payload.route, "decisions");
  assert.match(payload.endpoint, /\/alpha\/decisions$/);
});

test("jev_check reports ready:true with a key, without leaking it", async () => {
  const result = await withEnv({ JEV_API_KEY: "sk-mcp-not-real" }, () => callTool("jev_check", {}));

  const payload = parseContent(result);
  assert.equal(payload.ready, true);
  assert.equal(payload.key.source, "JEV_API_KEY");
  assert.doesNotMatch(JSON.stringify(result), /sk-mcp-not-real/);
});

test("jev_decide without a key is a tool error with remediation, not a crash", async () => {
  const result = await withEnv({}, () =>
    callTool("jev_decide", { state: "diff", questions: { gate: { type: "noul" } } }),
  );

  assert.equal(result.isError, true);
  const payload = parseContent(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "JEV_CONFIG");
  assert.match(payload.remediation, /OPENROUTER_API_KEY/);
  assert.match(payload.remediation, /JEV_API_KEY_FILE/);
});

test("jev_decide returns the DecisionResult as JSON text", async () => {
  const result = await withEnv({ JEV_API_KEY: "test-key" }, () =>
    callTool(
      "jev_decide",
      { state: "diff", questions: { gate: { type: "noul" } }, route: "systemone" },
      { decideImpl: async (request) => {
        assert.equal(request.state, "diff");
        assert.equal(request.route, "systemone");
        return { ...DECISION_RESULT, route: "systemone" };
      } },
    ),
  );

  assert.notEqual(result.isError, true);
  const payload = parseContent(result);
  assert.equal(payload.answers.gate.noul, 0.33);
  assert.equal(payload.verdict, undefined, "no policy, no verdict");
});

test("jev_decide composes decide() and verdict() when a policy object is given", async () => {
  const policy = { gate: { acceptAt: 0.9, reviewAt: 0.6 } };
  const result = await withEnv({ JEV_API_KEY: "test-key" }, () =>
    callTool(
      "jev_decide",
      { state: "diff", questions: { gate: { type: "noul" } }, policy },
      {
        decideImpl: async () => DECISION_RESULT,
        verdictImpl: (decisionResult, policyArg) => {
          assert.equal(decisionResult.answers.gate.noul, 0.33);
          assert.deepEqual(policyArg, policy);
          return { decision: "review", reasons: ["gate"], questions: { gate: { action: "review", value: 0.33 } } };
        },
      },
    ),
  );

  const payload = parseContent(result);
  assert.equal(payload.verdict.decision, "review");
  assert.deepEqual(payload.verdict.reasons, ["gate"]);
  assert.equal(payload.answers.gate.noul, 0.33);
});

test("jev_decide accepts a policy id and fails cleanly when it does not exist", async () => {
  const result = await withEnv({ JEV_API_KEY: "test-key" }, () =>
    callTool(
      "jev_decide",
      { state: "diff", questions: { gate: { type: "noul" } }, policy: "definitely-not-a-policy" },
      { decideImpl: async () => DECISION_RESULT },
    ),
  );

  assert.equal(result.isError, true);
  const payload = parseContent(result);
  assert.equal(payload.error.code, "JEV_CONFIG");
  assert.match(payload.error.message, /Unknown policy "definitely-not-a-policy"/);
});

test("jev_decide rejects a malformed policy argument", async () => {
  const result = await withEnv({ JEV_API_KEY: "test-key" }, () =>
    callTool("jev_decide", { state: "diff", questions: { gate: { type: "noul" } }, policy: 42 }, {
      decideImpl: async () => DECISION_RESULT,
    }),
  );

  assert.equal(result.isError, true);
  assert.match(parseContent(result).error.message, /policy/);
});

test("jev_decide turns a request failure into a tool error", async () => {
  const result = await withEnv({ JEV_API_KEY: "test-key" }, () =>
    callTool(
      "jev_decide",
      { state: "diff", questions: { gate: { type: "noul" } } },
      {
        decideImpl: async () => {
          throw new JevRequestError("Decisions API returned 500.", { status: 500 });
        },
      },
    ),
  );

  assert.equal(result.isError, true);
  const payload = parseContent(result);
  assert.equal(payload.error.code, "JEV_REQUEST");
  assert.equal(payload.error.details.status, 500);
});

test("jev_decide rejects a call with no state", async () => {
  const result = await withEnv({ JEV_API_KEY: "test-key" }, () => callTool("jev_decide", { questions: {} }));

  assert.equal(result.isError, true);
  assert.equal(parseContent(result).error.code, "JEV_USAGE");
});

test("jev_policies returns the policy index", async () => {
  const result = await withEnv({}, () => callTool("jev_policies", {}));

  assert.notEqual(result.isError, true);
  const payload = parseContent(result);
  assert.ok(Array.isArray(payload.policies));
  assert.equal(payload.count, payload.policies.length);
});

test("an unknown tool name is a tool error", async () => {
  const result = await withEnv({}, () => callTool("jev_nope", {}));

  assert.equal(result.isError, true);
  assert.match(parseContent(result).error.message, /Unknown tool/);
});

test("createServer builds a server and registers the handlers when the SDK is present", async (t) => {
  const sdk = await loadSdk();

  if (!sdk) {
    t.skip("MCP SDK not installed: npm install --prefix jev @modelcontextprotocol/sdk");
    return;
  }

  const server = await createServer();
  assert.equal(typeof server.connect, "function");
  assert.equal(typeof server.setRequestHandler, "function");
});

test("a missing SDK prints the install line and exits 2, with no stack trace", async (t) => {
  const sdk = await loadSdk();

  if (sdk) {
    t.skip("MCP SDK is installed, so the missing-SDK path cannot be exercised here");
    return;
  }

  const result = spawnSync(process.execPath, [MCP_ENTRY], { encoding: "utf8", timeout: 60_000 });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "", "an MCP server must not write to stdout outside the protocol");
  assert.ok(
    result.stderr.includes(MCP_SDK_MISSING_MESSAGE),
    `stderr should carry the install line, got: ${result.stderr}`,
  );
  assert.ok(result.stderr.startsWith("MCP SDK missing. Run: npm install --prefix "));
  assert.ok(result.stderr.includes("@modelcontextprotocol/sdk"));
  assert.ok(!/\n\s+at /.test(result.stderr), "no stack trace");
});
