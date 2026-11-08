// CLI contract tests. No network, no real key, no policy files on disk:
// everything the CLI touches goes through the injected deps of main().

import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { POLICIES_DIR, exitCodeForVerdict, main, parseArgv, policyThresholds } from "../src/cli.mjs";
import { JevConfigError, JevRequestError } from "../src/config.mjs";

const ENV_KEYS = [
  "JEV_API_KEY",
  "JEV_API_KEY_FILE",
  "OPENROUTER_API_KEY",
  "TYPESAFE_API_KEY",
  "JEV_BASE_URL",
  "JEV_ROUTE",
  "JEV_MODEL",
  "JEV_RECEIPTS_PATH",
  "JEV_TIMEOUT_MS",
  "JEV_MAX_RETRIES",
];

function isolateEnv(overrides = {}) {
  const saved = new Map();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// Runs main() with captured streams, a virtual filesystem and a clean env.
async function run(argv, options = {}) {
  const { env = {}, files = {}, stdin = "", deps = {} } = options;
  const restore = isolateEnv(env);
  const out = { stdout: "", stderr: "" };

  try {
    const code = await main(argv, {
      writeImpl: (text, stream = "stdout") => {
        out[stream] += text;
      },
      readFileImpl: async (path) => {
        const key = String(path);
        if (!Object.prototype.hasOwnProperty.call(files, key)) {
          const error = new Error(`ENOENT: no such file or directory, open '${key}'`);
          error.code = "ENOENT";
          throw error;
        }
        return files[key];
      },
      readStdinImpl: async () => stdin,
      ...deps,
    });
    return { code, stdout: out.stdout, stderr: out.stderr, json: () => JSON.parse(out.stdout) };
  } finally {
    restore();
  }
}

const ACCEPT_RESULT = {
  ok: true,
  requestId: "req-1",
  model: "typesafe/jev-1.13",
  route: "decisions",
  answers: { gate: { type: "noul", noul: 0.97 } },
  usage: { inputTokens: 120, outputTokens: 8, costUsd: 0.0004 },
  latencyMs: 812,
};

const DECIDE_FILES = {
  "state.json": JSON.stringify({ diff: "+ return 42;" }),
  "questions.json": JSON.stringify({ gate: { type: "noul", instructions: "Is this safe to merge?" } }),
};

test("parseArgv reads value flags, boolean flags and the --flag=value form", () => {
  const parsed = parseArgv([
    "decide",
    "--state",
    "state.json",
    "--questions=-",
    "--policy",
    "run-accept",
    "--route=systemone",
    "--include-raw",
  ]);

  assert.deepEqual(parsed.positionals, ["decide"]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.flags["--state"], "state.json");
  assert.equal(parsed.flags["--questions"], "-");
  assert.equal(parsed.flags["--policy"], "run-accept");
  assert.equal(parsed.flags["--route"], "systemone");
  assert.equal(parsed.flags["--include-raw"], true);
});

test("parseArgv reports unknown flags and value flags with no value", () => {
  const parsed = parseArgv(["decide", "--wat", "--state"]);
  assert.equal(parsed.errors.length, 2);
  assert.match(parsed.errors[0], /Unknown flag "--wat"/);
  assert.match(parsed.errors[1], /needs a value/);
});

test("help prints usage as one JSON document on stdout", async () => {
  const result = await run(["help"]);

  assert.equal(result.code, 0);
  const payload = result.json();
  assert.equal(payload.ok, true);
  assert.match(payload.usage, /jev decide/);
  assert.deepEqual(
    payload.commands.map((command) => command.name),
    ["decide", "check", "policies", "help"],
  );
  // Usage is human text, so it is also on stderr.
  assert.match(result.stderr, /jev decide/);
});

test("--help behaves like help", async () => {
  const result = await run(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.json().usage, /Exit codes: 0 accept/);
});

test("no command exits 2 with a usage JSON document", async () => {
  const result = await run([]);

  assert.equal(result.code, 2);
  assert.equal(result.json().error.code, "JEV_USAGE");
  assert.match(result.stderr, /No command given/);
});

test("unknown command exits 2", async () => {
  const result = await run(["frobnicate"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command "frobnicate"/);
  assert.equal(result.json().error.code, "JEV_USAGE");
});

test("decide without --state exits 2 before touching config or stdin", async () => {
  const result = await run(["decide", "--questions", "questions.json"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /needs both --state and --questions/);
  assert.equal(result.json().error.code, "JEV_USAGE");
});

test("check without a key exits 0 and reports ready:false", async () => {
  const result = await run(["check"]);

  assert.equal(result.code, 0);
  const payload = result.json();
  assert.equal(payload.ready, false);
  assert.equal(payload.key.present, false);
  assert.equal(payload.key.source, "none");
  assert.equal(payload.route, "decisions");
  assert.equal(payload.model, "typesafe/jev-1.13");
  assert.equal(payload.timeoutMs, 20000);
  assert.equal(payload.maxRetries, 2);
  assert.equal(payload.receiptsPath, null);
  assert.match(payload.endpoint, /\/alpha\/decisions$/);
  // The remediation hint is diagnostics, not part of the JSON document.
  assert.match(result.stderr, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(result.stdout, /OPENROUTER_API_KEY/);
});

test("check with a key reports ready:true and never prints the key", async () => {
  const result = await run(["check"], { env: { JEV_API_KEY: "sk-test-not-real" } });

  assert.equal(result.code, 0);
  const payload = result.json();
  assert.equal(payload.ready, true);
  assert.equal(payload.key.present, true);
  assert.equal(payload.key.source, "JEV_API_KEY");
  assert.doesNotMatch(result.stdout, /sk-test-not-real/);
});

test("decide without a key exits 2 and names both key sources on stderr", async () => {
  const result = await run(["decide", "--state", "state.json", "--questions", "questions.json"], {
    files: DECIDE_FILES,
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /OPENROUTER_API_KEY/);
  assert.match(result.stderr, /JEV_API_KEY_FILE/);
  const payload = result.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "JEV_CONFIG");
  assert.equal(payload.remediation.includes("OPENROUTER_API_KEY"), true);
});

test("decide calls decideImpl with resolved config defaults", async () => {
  let captured = null;
  const result = await run(["decide", "--state", "state.json", "--questions", "questions.json"], {
    env: { JEV_API_KEY: "test-key" },
    files: DECIDE_FILES,
    deps: {
      decideImpl: async (request) => {
        captured = request;
        return ACCEPT_RESULT;
      },
    },
  });

  assert.equal(result.code, 0);
  assert.deepEqual(captured.state, { diff: "+ return 42;" });
  assert.deepEqual(captured.questions, { gate: { type: "noul", instructions: "Is this safe to merge?" } });
  assert.equal(captured.route, "decisions", "route defaults to decisions");
  assert.equal(captured.model, "typesafe/jev-1.13", "model defaults to the config model");
  assert.equal(captured.includeRaw, undefined, "--include-raw is off by default");
  assert.equal(captured.receiptsPath, undefined, "no receipts path unless configured");
  assert.equal(result.json().answers.gate.noul, 0.97);
});

test("--model, --route, --receipts and --include-raw reach the request", async () => {
  let captured = null;
  await run(
    [
      "decide",
      "--state",
      "state.json",
      "--questions",
      "questions.json",
      "--model",
      "custom/model",
      "--route",
      "systemone",
      "--receipts",
      "receipts.jsonl",
      "--include-raw",
    ],
    {
      env: { JEV_API_KEY: "test-key" },
      files: DECIDE_FILES,
      deps: {
        decideImpl: async (request) => {
          captured = request;
          return { ...ACCEPT_RESULT, route: "systemone", raw: { id: "raw" } };
        },
      },
    },
  );

  assert.equal(captured.model, "custom/model");
  assert.equal(captured.route, "systemone");
  assert.equal(captured.receiptsPath, "receipts.jsonl");
  assert.equal(captured.includeRaw, true);
});

test("--state - reads the state JSON from stdin", async () => {
  let captured = null;
  const result = await run(["decide", "--state", "-", "--questions", "questions.json"], {
    env: { JEV_API_KEY: "test-key" },
    stdin: JSON.stringify({ plan: ["ship it"] }),
    files: { "questions.json": DECIDE_FILES["questions.json"] },
    deps: {
      decideImpl: async (request) => {
        captured = request;
        return ACCEPT_RESULT;
      },
    },
  });

  assert.equal(result.code, 0);
  assert.deepEqual(captured.state, { plan: ["ship it"] });
});

test("--questions - reads the questions JSON from stdin", async () => {
  let captured = null;
  const result = await run(["decide", "--state", "state.json", "--questions", "-"], {
    env: { JEV_API_KEY: "test-key" },
    stdin: DECIDE_FILES["questions.json"],
    files: { "state.json": DECIDE_FILES["state.json"] },
    deps: {
      decideImpl: async (request) => {
        captured = request;
        return ACCEPT_RESULT;
      },
    },
  });

  assert.equal(result.code, 0);
  assert.deepEqual(captured.questions, { gate: { type: "noul", instructions: "Is this safe to merge?" } });
});

test("malformed input JSON is a usage error (exit 2)", async () => {
  const result = await run(["decide", "--state", "state.json", "--questions", "questions.json"], {
    env: { JEV_API_KEY: "test-key" },
    files: { "state.json": "{not json", "questions.json": "{}" },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /invalid JSON/);
  assert.equal(result.json().error.code, "JEV_USAGE");
});

test("an unknown --route is a config error (exit 2)", async () => {
  const result = await run(
    ["decide", "--state", "state.json", "--questions", "questions.json", "--route", "nope"],
    { env: { JEV_API_KEY: "test-key" }, files: DECIDE_FILES },
  );

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown route/);
  assert.equal(result.json().error.code, "JEV_CONFIG");
});

test("accept verdict exits 0 (runAccept)", async () => {
  const result = await run(
    ["decide", "--state", "state.json", "--questions", "questions.json", "--policy", "run-accept"],
    {
      env: { JEV_API_KEY: "test-key" },
      files: {
        ...DECIDE_FILES,
        [resolve(POLICIES_DIR, "run-accept.json")]: JSON.stringify({ gate: { acceptAt: 0.9, reviewAt: 0.6 } }),
      },
      deps: {
        decideImpl: async () => ACCEPT_RESULT,
        verdictImpl: (decisionResult, policy) => {
          assert.deepEqual(policy, { gate: { acceptAt: 0.9, reviewAt: 0.6 } });
          assert.equal(decisionResult.answers.gate.noul, 0.97);
          return { decision: "accept", reasons: [], questions: { gate: { action: "accept", value: 0.97 } } };
        },
      },
    },
  );

  assert.equal(result.code, 0);
  const payload = result.json();
  assert.equal(payload.verdict.decision, "accept");
  assert.match(result.stderr, /verdict: accept/);
});

test("escalation verdict exits 3 and keeps the DecisionResult on stdout", async () => {
  const result = await run(
    ["decide", "--state", "state.json", "--questions", "questions.json", "--policy", "review-lane"],
    {
      env: { JEV_API_KEY: "test-key" },
      files: {
        ...DECIDE_FILES,
        [resolve(POLICIES_DIR, "review-lane.json")]: JSON.stringify({ gate: { acceptAt: 0.9, reviewAt: 0.6 } }),
      },
      deps: {
        decideImpl: async () => ({ ...ACCEPT_RESULT, answers: { gate: { type: "noul", noul: 0.4 } } }),
        verdictImpl: () => ({
          decision: "review",
          reasons: ["gate"],
          questions: { gate: { action: "review", value: 0.4 } },
        }),
      },
    },
  );

  assert.equal(result.code, 3);
  const payload = result.json();
  assert.equal(payload.answers.gate.noul, 0.4, "the result is still emitted");
  assert.equal(payload.verdict.decision, "review");
  assert.match(result.stderr, /verdict: review \(gate\)/);
});

test("a reject verdict also exits 3", async () => {
  const result = await run(
    ["decide", "--state", "state.json", "--questions", "questions.json", "--policy", "review-lane"],
    {
      env: { JEV_API_KEY: "test-key" },
      files: {
        ...DECIDE_FILES,
        [resolve(POLICIES_DIR, "review-lane.json")]: JSON.stringify({ gate: { acceptAt: 0.9 } }),
      },
      deps: {
        decideImpl: async () => ACCEPT_RESULT,
        verdictImpl: () => ({ decision: "reject", reasons: ["gate"], questions: {} }),
      },
    },
  );

  assert.equal(result.code, 3);
});

test("exitCodeForVerdict maps accept to 0 and escalation to 3", () => {
  assert.equal(exitCodeForVerdict("accept"), 0);
  assert.equal(exitCodeForVerdict("review"), 3);
  assert.equal(exitCodeForVerdict("reject"), 3);
});

test("an unknown policy id exits 2 and points at jev policies", async () => {
  const result = await run(
    ["decide", "--state", "state.json", "--questions", "questions.json", "--policy", "nope"],
    { env: { JEV_API_KEY: "test-key" }, files: DECIDE_FILES },
  );

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown policy "nope"/);
  assert.match(result.stderr, /jev policies/);
});

test("a policy id with a path separator exits 2 without reading outside policies/", async () => {
  const reads = [];
  const result = await run(
    ["decide", "--state", "state.json", "--questions", "questions.json", "--policy", "../secrets"],
    {
      env: { JEV_API_KEY: "test-key" },
      files: DECIDE_FILES,
      deps: {
        readFileImpl: async (path) => {
          const key = String(path);
          reads.push(key);
          if (!Object.prototype.hasOwnProperty.call(DECIDE_FILES, key)) {
            const error = new Error(`ENOENT: ${key}`);
            error.code = "ENOENT";
            throw error;
          }
          return DECIDE_FILES[key];
        },
      },
    },
  );

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Invalid policy id/);
  assert.deepEqual(
    reads.filter((path) => path.includes("secrets")),
    [],
    "an invalid policy id must never reach the filesystem",
  );
});

test("a broken decideImpl that reports a config error exits 2 with remediation", async () => {
  const result = await run(["decide", "--state", "state.json", "--questions", "questions.json"], {
    env: { JEV_API_KEY: "test-key" },
    files: DECIDE_FILES,
    deps: {
      decideImpl: async () => {
        throw new JevConfigError("Missing API key for the Jev request.");
      },
    },
  });

  assert.equal(result.code, 2);
  assert.equal(result.json().error.code, "JEV_CONFIG");
  assert.match(result.stderr, /OPENROUTER_API_KEY/);
  assert.match(result.stderr, /JEV_API_KEY_FILE/);
});

test("a request error exits 1", async () => {
  const result = await run(["decide", "--state", "state.json", "--questions", "questions.json"], {
    env: { JEV_API_KEY: "test-key" },
    files: DECIDE_FILES,
    deps: {
      decideImpl: async () => {
        throw new JevRequestError("Decisions API returned 503 after 2 retries.", { status: 503, reason: "http" });
      },
    },
  });

  assert.equal(result.code, 1);
  assert.equal(result.json().error.code, "JEV_REQUEST");
  assert.equal(result.json().error.details.status, 503);
});

test("a packaged policy document is unwrapped to flat thresholds before verdict()", async () => {
  const document = {
    id: "review-gate",
    description: "Gate a change through named checks.",
    model: "typesafe/jev-1.13",
    questions: { gate: { type: "noul", instructions: "Safe?" } },
    policy: { gate: { acceptAt: 0.9, reviewAt: 0.6 } },
  };

  const result = await run(
    ["decide", "--state", "state.json", "--questions", "questions.json", "--policy", "review-gate"],
    {
      env: { JEV_API_KEY: "test-key" },
      files: { ...DECIDE_FILES, [resolve(POLICIES_DIR, "review-gate.json")]: JSON.stringify(document) },
      deps: {
        decideImpl: async () => ACCEPT_RESULT,
        verdictImpl: (decisionResult, policy) => {
          assert.deepEqual(policy, { gate: { acceptAt: 0.9, reviewAt: 0.6 } });
          return { decision: "accept", reasons: [], questions: {} };
        },
      },
    },
  );

  assert.equal(result.code, 0);
});

test("policyThresholds accepts the flat contract shape and strips document metadata", () => {
  assert.deepEqual(policyThresholds({ gate: { acceptAt: 0.9 } }), { gate: { acceptAt: 0.9 } });
  assert.deepEqual(
    policyThresholds({ id: "x", description: "d", notes: "n", gate: { acceptAt: 0.9 } }),
    { gate: { acceptAt: 0.9 } },
  );
  assert.deepEqual(policyThresholds({ policy: { gate: { acceptAt: 0.9 } }, id: "x" }), { gate: { acceptAt: 0.9 } });
  assert.deepEqual(policyThresholds({}), {});
});

test("policies exits 0 with an array of {id, description} entries", async () => {
  const result = await run(["policies"]);

  assert.equal(result.code, 0);
  const payload = result.json();
  assert.ok(Array.isArray(payload.policies));
  assert.equal(payload.count, payload.policies.length);
  for (const entry of payload.policies) {
    assert.equal(typeof entry.id, "string");
    assert.ok(Object.prototype.hasOwnProperty.call(entry, "description"));
  }
});

test("every invocation keeps stdout parseable", async () => {
  const cases = [
    [],
    ["help"],
    ["check"],
    ["policies"],
    ["nope"],
    ["decide"],
    ["decide", "--state", "state.json"],
  ];

  for (const argv of cases) {
    const result = await run(argv);
    assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout must parse for: jev ${argv.join(" ")}`);
    assert.equal(typeof result.code, "number");
  }
});
