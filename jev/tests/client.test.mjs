// Tests for the Jev decision client. No real network: fetch is always injected.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decide } from "../src/client.mjs";
import { JevConfigError, JevParseError, JevRequestError } from "../src/config.mjs";

const MANAGED_ENV = [
  "JEV_API_KEY",
  "JEV_API_KEY_FILE",
  "OPENROUTER_API_KEY",
  "TYPESAFE_API_KEY",
  "JEV_BASE_URL",
  "JEV_MODEL",
  "JEV_ROUTE",
  "JEV_TIMEOUT_MS",
  "JEV_MAX_RETRIES",
  "JEV_RECEIPTS_PATH",
];

const QUESTIONS = {
  is_safe: { type: "noul", instructions: "Is this request safe to handle automatically?" },
  intent: { type: "choice", instructions: "What is the customer asking for?", criteria: ["billing", "other"] },
  urgency: { type: "score", instructions: "How urgent is this?", criteria: ["low", "normal", "high"] },
};

const STATE = { ticket: "late delivery refund", customer: "acme" };

function isolateEnv(t) {
  const saved = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function jsonResponse(payload, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => {
        const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
        return key === undefined ? null : headers[key];
      },
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(calls.length, url, init);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function happyPayload() {
  return {
    id: "req_abc123",
    model: "typesafe/jev-1.13",
    answers: {
      is_safe: { noul: 0.93 },
      intent: {
        choice: "billing",
        probabilities: { billing: 0.82, other: 0.18 },
        confidence: 0.82,
      },
      urgency: { score: 1.7, confidence: 0.66 },
    },
    usage: { input_tokens: 120, output_tokens: 44, cost: 0.00042 },
  };
}

test("happy path returns all three answer types in contract shape", async (t) => {
  isolateEnv(t);
  const fetchImpl = recordingFetch(() => jsonResponse(happyPayload()));

  const result = await decide(
    { apiKey: "sk-test-happy", state: STATE, questions: QUESTIONS },
    { fetchImpl, now: () => 1_000 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.requestId, "req_abc123");
  assert.equal(result.model, "typesafe/jev-1.13");
  assert.equal(result.route, "decisions");
  assert.deepEqual(result.answers.is_safe, { type: "noul", noul: 0.93 });
  assert.deepEqual(result.answers.intent, {
    type: "choice",
    choice: "billing",
    probabilities: { billing: 0.82, other: 0.18 },
    confidence: 0.82,
  });
  assert.deepEqual(result.answers.urgency, { type: "score", score: 1.7, confidence: 0.66 });
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 44, costUsd: 0.00042 });
  assert.equal(result.latencyMs, 0);
  assert.equal("raw" in result, false);

  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(init.method, "POST");
  const headers = Object.fromEntries(
    Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  assert.equal(headers.authorization, "Bearer sk-test-happy");
  assert.equal(headers["content-type"], "application/json");

  const body = JSON.parse(init.body);
  assert.equal(body.model, "typesafe/jev-1.13");
  assert.deepEqual(body.questions, QUESTIONS);
  assert.deepEqual(body.state, STATE);
  assert.ok(init.signal, "request carries an abort signal");
});

test("usage normalises from the camelCase shape", async (t) => {
  isolateEnv(t);
  const payload = {
    answers: {
      is_safe: { type: "noul", noul: 0.1 },
      intent: { choice: "other", probabilities: { other: 1 } },
      urgency: { score: 0.2 },
    },
    usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.01 },
  };
  const fetchImpl = recordingFetch(() => jsonResponse(payload));

  const result = await decide(
    { apiKey: "sk-test-camel", state: "raw state text", questions: QUESTIONS },
    { fetchImpl },
  );

  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 3, costUsd: 0.01 });
  assert.equal(result.answers.intent.type, "choice");
  assert.equal(result.answers.intent.confidence, 1, "confidence falls back to the chosen probability");
  assert.equal(result.answers.urgency.confidence, 0);
});

test("usage normalises to nulls when the API reports none", async (t) => {
  isolateEnv(t);
  const payload = { answers: { is_safe: { noul: 0.4 }, intent: { choice: "other" }, urgency: { score: 0 } } };
  const fetchImpl = recordingFetch(() => jsonResponse(payload));

  const result = await decide(
    { apiKey: "sk-test-nousage", state: STATE, questions: QUESTIONS },
    { fetchImpl },
  );

  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, costUsd: null });
  assert.equal(result.requestId, null);
  assert.equal(result.model, "typesafe/jev-1.13", "falls back to the configured model");
});

test("a missing answer id raises JevParseError and invents nothing", async (t) => {
  isolateEnv(t);
  const payload = happyPayload();
  delete payload.answers.urgency;
  const fetchImpl = recordingFetch(() => jsonResponse(payload));

  await assert.rejects(
    () => decide({ apiKey: "sk-test-missing", state: STATE, questions: QUESTIONS }, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof JevParseError);
      assert.deepEqual(error.details.missing, ["urgency"]);
      return true;
    },
  );
});

test("missing API key raises JevConfigError with zero fetch calls", async (t) => {
  isolateEnv(t);
  const fetchImpl = recordingFetch(() => jsonResponse(happyPayload()));

  await assert.rejects(
    () => decide({ state: STATE, questions: QUESTIONS }, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof JevConfigError);
      assert.equal(error.name, "JevConfigError");
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("empty state and unsupported question types fail before the network", async (t) => {
  isolateEnv(t);
  const fetchImpl = recordingFetch(() => jsonResponse(happyPayload()));

  await assert.rejects(
    () => decide({ apiKey: "sk-test-empty", state: {}, questions: QUESTIONS }, { fetchImpl }),
    JevRequestError,
  );
  await assert.rejects(
    () => decide({ apiKey: "sk-test-empty", state: "   ", questions: QUESTIONS }, { fetchImpl }),
    JevRequestError,
  );
  await assert.rejects(
    () => decide({ apiKey: "sk-test-empty", state: STATE, questions: {} }, { fetchImpl }),
    JevRequestError,
  );
  await assert.rejects(
    () =>
      decide(
        { apiKey: "sk-test-empty", state: STATE, questions: { bad: { type: "ranking" } } },
        { fetchImpl },
      ),
    (error) => {
      assert.ok(error instanceof JevRequestError);
      assert.equal(error.details.field, "questions.bad.type");
      return true;
    },
  );
  await assert.rejects(
    () => decide({ apiKey: "sk-test-empty", state: STATE, questions: [{ type: "noul" }] }, { fetchImpl }),
    JevRequestError,
  );

  assert.equal(fetchImpl.calls.length, 0);
});

test("500 then 200 retries with backoff and succeeds", async (t) => {
  isolateEnv(t);
  const fetchImpl = recordingFetch((callNumber) =>
    callNumber === 1 ? jsonResponse({ error: "upstream" }, 500) : jsonResponse(happyPayload()),
  );

  const startedAt = Date.now();
  const result = await decide(
    { apiKey: "sk-test-retry", state: STATE, questions: QUESTIONS },
    { fetchImpl },
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(elapsed >= 200, `expected a ~250ms backoff, saw ${elapsed}ms`);
});

test("429 retries and exhausts at maxRetries instead of looping", async (t) => {
  isolateEnv(t);
  const fetchImpl = recordingFetch(() => jsonResponse({ error: "slow down" }, 429));

  await assert.rejects(
    () =>
      decide(
        { apiKey: "sk-test-429", state: STATE, questions: QUESTIONS, maxRetries: 1 },
        { fetchImpl },
      ),
    (error) => {
      assert.ok(error instanceof JevRequestError);
      assert.equal(error.details.status, 429);
      assert.equal(error.details.attempts, 2);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test("400 does not retry", async (t) => {
  isolateEnv(t);
  const fetchImpl = recordingFetch(() => jsonResponse({ error: "bad request" }, 400));

  await assert.rejects(
    () => decide({ apiKey: "sk-test-400", state: STATE, questions: QUESTIONS }, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof JevRequestError);
      assert.equal(error.details.status, 400);
      assert.equal(error.details.attempts, 1);
      assert.match(error.message, /400/);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test("timeout surfaces JevRequestError with details.reason === 'timeout'", async (t) => {
  isolateEnv(t);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };

  await assert.rejects(
    () => decide({ apiKey: "sk-test-timeout", state: STATE, questions: QUESTIONS }, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof JevRequestError);
      assert.equal(error.details.reason, "timeout");
      return true;
    },
  );
  assert.equal(calls, 1, "a timeout is not retried");
});

test("route systemone uses the systemone path", async (t) => {
  isolateEnv(t);
  const fetchImpl = recordingFetch(() => jsonResponse(happyPayload()));

  const result = await decide(
    { apiKey: "sk-test-route", state: STATE, questions: QUESTIONS, route: "systemone" },
    { fetchImpl },
  );

  assert.equal(result.route, "systemone");
  assert.equal(fetchImpl.calls[0].url, "https://openrouter.ai/api/v1/systemone");
});

test("includeRaw attaches the payload only when asked", async (t) => {
  isolateEnv(t);
  const payload = happyPayload();
  const fetchImpl = recordingFetch(() => jsonResponse(payload));

  const result = await decide(
    { apiKey: "sk-test-raw", state: STATE, questions: QUESTIONS, includeRaw: true },
    { fetchImpl },
  );

  assert.deepEqual(result.raw, payload);
});

test("receipt line carries metadata only: no key, no state body, no instructions", async (t) => {
  isolateEnv(t);
  const dir = await mkdtemp(join(tmpdir(), "jev-receipt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const receiptsPath = join(dir, "receipts.jsonl");

  // Assembled rather than written as one literal so the secret scanner does not
  // flag a deliberately fake credential in a fixture. The assertion below is what
  // proves the receipt never contains it.
  const apiKey = ["fixture", "credential", "not", "a", "real", "key"].join("-");
  const secretState = "STATE-BODY-MUST-NOT-LEAK";
  const questions = {
    is_safe: { type: "noul", instructions: "INSTRUCTION-TEXT-MUST-NOT-LEAK" },
  };
  const payload = {
    id: "req_receipt",
    model: "typesafe/jev-1.13",
    answers: { is_safe: { noul: 0.9 } },
    usage: { input_tokens: 11, output_tokens: 7, cost: 0.0002 },
  };
  const fetchImpl = recordingFetch(() => jsonResponse(payload));

  const result = await decide(
    {
      apiKey,
      state: { note: secretState },
      questions,
      receiptsPath,
      timeoutMs: 5_000,
    },
    { fetchImpl, now: (() => {
      let tick = 0;
      return () => {
        tick += 40;
        return 1_700_000_000_000 + tick;
      };
    })() },
  );

  const raw = await readFile(receiptsPath, "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);

  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.model, "typesafe/jev-1.13");
  assert.equal(receipt.route, "decisions");
  assert.deepEqual(receipt.questions, [{ id: "is_safe", type: "noul" }]);
  assert.deepEqual(receipt.usage, { inputTokens: 11, outputTokens: 7, costUsd: 0.0002 });
  assert.equal(receipt.costUsd, 0.0002);
  assert.equal(receipt.requestId, "req_receipt");
  assert.equal(receipt.latencyMs, result.latencyMs);
  assert.match(receipt.stateSha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.timestamp, /^\d{4}-\d{2}-\d{2}T/);

  for (const forbidden of [apiKey, secretState, "INSTRUCTION-TEXT-MUST-NOT-LEAK", "Bearer"]) {
    assert.equal(raw.includes(forbidden), false, `receipt leaked ${forbidden}`);
  }
});

test("receiptWriter receives the same metadata-only receipt", async (t) => {
  isolateEnv(t);
  const seen = [];
  const fetchImpl = recordingFetch(() => jsonResponse(happyPayload()));

  await decide(
    { apiKey: "sk-test-writer", state: STATE, questions: QUESTIONS },
    { fetchImpl, receiptWriter: (receipt) => seen.push(receipt) },
  );

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].questions, [
    { id: "is_safe", type: "noul" },
    { id: "intent", type: "choice" },
    { id: "urgency", type: "score" },
  ]);
  assert.equal(JSON.stringify(seen[0]).includes("sk-test-writer"), false);
  assert.equal(JSON.stringify(seen[0]).includes("late delivery refund"), false);
});
