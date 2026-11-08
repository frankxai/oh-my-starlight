// Tests for the question builders and verdict ladder.

import test from "node:test";
import assert from "node:assert/strict";

import { choice, noul, noulTrue, score, verdict } from "../src/questions.mjs";
import { JevConfigError, JevParseError } from "../src/config.mjs";

function result(answers) {
  return { ok: true, requestId: "req_1", model: "typesafe/jev-1.13", route: "decisions", answers };
}

test("noul, choice and score build typed questions", () => {
  assert.deepEqual(noul("Is it safe?", "no PII"), {
    type: "noul",
    instructions: "Is it safe?",
    criteria: "no PII",
  });
  assert.deepEqual(noul("Is it safe?", ["no PII", "no billing"]), {
    type: "noul",
    instructions: "Is it safe?",
    criteria: ["no PII", "no billing"],
  });
  assert.deepEqual(choice("Which team?", ["billing", "other"]), {
    type: "choice",
    instructions: "Which team?",
    criteria: ["billing", "other"],
  });
  assert.deepEqual(choice("Which team?", { billing: "money", other: "everything else" }), {
    type: "choice",
    instructions: "Which team?",
    criteria: { billing: "money", other: "everything else" },
  });
  assert.deepEqual(score("How urgent?", ["low", "high"]), {
    type: "score",
    instructions: "How urgent?",
    criteria: ["low", "high"],
  });
  assert.deepEqual(score("How urgent?", { levels: ["low", "high"] }), {
    type: "score",
    instructions: "How urgent?",
    criteria: { levels: ["low", "high"] },
  });
});

test("builders reject empty instructions and unusable criteria", () => {
  assert.throws(() => noul("", "hint"), JevConfigError);
  assert.throws(() => noul("  ", "hint"), JevConfigError);
  assert.throws(() => choice("Pick", []), JevConfigError);
  assert.throws(() => choice("Pick", {}), JevConfigError);
  assert.throws(() => choice("Pick", "billing"), JevConfigError);
  assert.throws(() => score("Rate", { levels: [] }), JevConfigError);
  assert.throws(() => score("Rate", ["low", "low"]), JevConfigError);
});

test("noulTrue reads raw numbers and noul answers at the threshold", () => {
  assert.equal(noulTrue(0.7), true);
  assert.equal(noulTrue({ type: "noul", noul: 0.7 }), true);
  assert.equal(noulTrue(0.5), true, "at the threshold counts as true");
  assert.equal(noulTrue(0.49), false);
  assert.equal(noulTrue(0.3, 0.2), true);
  assert.equal(noulTrue({ noul: 0.3 }, 0.4), false);
  assert.throws(() => noulTrue("0.9"), JevParseError);
  assert.throws(() => noulTrue({ score: 0.9 }), JevParseError);
  assert.throws(() => noulTrue(0.9, Number.NaN), JevConfigError);
});

test("policy verdict: reject beats review beats accept", () => {
  const verdictResult = verdict(
    result({
      safe: { type: "noul", noul: 0.95 },
      intent: { type: "choice", choice: "billing", probabilities: { billing: 0.8 }, confidence: 0.8 },
      urgency: { type: "score", score: 0.1, confidence: 0.4 },
    }),
    {
      safe: { acceptAt: 0.9 },
      intent: { acceptWhen: ["billing"], reviewWhen: ["other"] },
      urgency: { acceptAt: 1.5, reviewAt: 0.9 },
    },
  );

  assert.equal(verdictResult.decision, "reject");
  assert.deepEqual(verdictResult.reasons, ["urgency"]);
  assert.deepEqual(verdictResult.questions.safe, { action: "accept", value: 0.95 });
  assert.deepEqual(verdictResult.questions.intent, {
    action: "accept",
    value: "billing",
    confidence: 0.8,
  });
  assert.deepEqual(verdictResult.questions.urgency, {
    action: "reject",
    value: 0.1,
    confidence: 0.4,
  });
});

test("policy verdict: review wins when no question rejects", () => {
  const verdictResult = verdict(
    result({
      safe: { type: "noul", noul: 0.95 },
      intent: { type: "choice", choice: "other", probabilities: { other: 0.6 } },
    }),
    {
      safe: { acceptAt: 0.9 },
      intent: { acceptWhen: ["billing"], reviewWhen: ["other"] },
    },
  );

  assert.equal(verdictResult.decision, "review");
  assert.deepEqual(verdictResult.reasons, ["intent"]);
  assert.equal(verdictResult.questions.intent.action, "review");
});

test("policy verdict: all-accept returns accept with no reasons", () => {
  const verdictResult = verdict(result({ safe: { type: "noul", noul: 0.99 } }), {
    safe: { acceptAt: 0.9, reviewAt: 0.5 },
  });

  assert.equal(verdictResult.decision, "accept");
  assert.deepEqual(verdictResult.reasons, []);
});

test("policy verdict: a choice outside acceptWhen and reviewWhen rejects", () => {
  const verdictResult = verdict(result({ intent: { type: "choice", choice: "sales" } }), {
    intent: { acceptWhen: ["billing"], reviewWhen: ["other"] },
  });

  assert.equal(verdictResult.decision, "reject");
  assert.deepEqual(verdictResult.reasons, ["intent"]);
});

test("policy verdict: score thresholds read the score, not noul", () => {
  const policy = { urgency: { acceptAt: 1.5, reviewAt: 0.9 } };

  assert.equal(verdict(result({ urgency: { type: "score", score: 1.6 } }), policy).decision, "accept");
  assert.equal(verdict(result({ urgency: { type: "score", score: 0.9 } }), policy).decision, "review");
  assert.equal(verdict(result({ urgency: { type: "score", score: 0.2 } }), policy).decision, "reject");
});

test("policy verdict: a missing answer is review with reason missing:<id>", () => {
  const verdictResult = verdict(result({ safe: { type: "noul", noul: 0.99 } }), {
    safe: { acceptAt: 0.9 },
    intent: { acceptWhen: ["billing"] },
  });

  assert.equal(verdictResult.decision, "review");
  assert.deepEqual(verdictResult.reasons, ["missing:intent"]);
  assert.equal("intent" in verdictResult.questions, false, "no invented question entry");
});

test("policy verdict: missing never outranks a reject", () => {
  const verdictResult = verdict(
    result({ safe: { type: "noul", noul: 0.1 } }),
    { safe: { acceptAt: 0.9, reviewAt: 0.5 }, intent: { acceptWhen: ["billing"] } },
  );

  assert.equal(verdictResult.decision, "reject");
  assert.deepEqual(verdictResult.reasons, ["safe"]);
});

test("policy verdict: empty or absent policy is accept with reason no-policy", () => {
  assert.deepEqual(verdict(result({ safe: { type: "noul", noul: 0.1 } }), {}), {
    decision: "accept",
    reasons: ["no-policy"],
    questions: {},
  });
  assert.deepEqual(verdict(result({ safe: { type: "noul", noul: 0.1 } })), {
    decision: "accept",
    reasons: ["no-policy"],
    questions: {},
  });
});

test("policy verdict: unconfigured thresholds fail closed as review", () => {
  const verdictResult = verdict(result({ safe: { type: "noul", noul: 0.99 } }), { safe: {} });

  assert.equal(verdictResult.decision, "review");
  assert.deepEqual(verdictResult.reasons, ["unconfigured:safe"]);
});

test("policy verdict: bad inputs raise config or parse errors, not silent accepts", () => {
  assert.throws(() => verdict(null, {}), JevConfigError);
  assert.throws(() => verdict({ answers: null }, {}), JevConfigError);
  assert.throws(() => verdict(result({}), []), JevConfigError);
  assert.throws(() => verdict(result({ safe: 0.9 }), { safe: { acceptAt: 0.5 } }), JevParseError);
  assert.throws(
    () => verdict(result({ safe: { type: "noul", noul: 0.9 } }), { safe: "accept" }),
    JevConfigError,
  );
});
