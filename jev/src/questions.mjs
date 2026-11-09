// Question builders and verdict evaluation for the Jev decision layer.
// Zero dependencies. Errors come from ./config.mjs so callers can catch one family.

import { JevConfigError, JevParseError } from "./config.mjs";

/**
 * P(true) question. `criteria` is an optional hint describing what "true" means.
 * @param {string} instructions
 * @param {string|string[]} [criteria]
 */
export function noul(instructions, criteria) {
  const question = { type: "noul", instructions: requireText(instructions, "instructions") };
  if (criteria !== undefined && criteria !== null) {
    question.criteria =
      typeof criteria === "string"
        ? requireText(criteria, "criteria")
        : requireTextList(criteria, "criteria");
  }
  return question;
}

/**
 * Single-label question.
 * @param {string} instructions
 * @param {string[]|Record<string, string>} criteria
 */
export function choice(instructions, criteria) {
  return {
    type: "choice",
    instructions: requireText(instructions, "instructions"),
    criteria: requireChoiceCriteria(criteria),
  };
}

/**
 * Ordered scale question.
 * @param {string} instructions
 * @param {string[]|{levels: string[]}} criteria ordered levels, lowest first
 */
export function score(instructions, criteria) {
  return {
    type: "score",
    instructions: requireText(instructions, "instructions"),
    criteria: requireScoreCriteria(criteria),
  };
}

/**
 * True when a noul answer is at or above the threshold.
 * @param {number|{noul: number}} answer
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function noulTrue(answer, threshold = 0.5) {
  const value = typeof answer === "number" ? answer : isPlainObject(answer) ? answer.noul : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new JevParseError("noulTrue expects a finite noul answer.", { answer: typeof answer });
  }
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    throw new JevConfigError("noulTrue threshold must be a finite number.", {
      field: "threshold",
      value: threshold,
    });
  }
  return value >= threshold;
}

/**
 * Reduce a DecisionResult against a policy to one branchable verdict.
 * The strictest outcome wins: reject > review > accept.
 *
 * @param {{answers?: object}} result
 * @param {object} [policy]
 * @returns {{decision: "accept"|"review"|"reject", reasons: string[], questions: object}}
 */
export function verdict(result, policy) {
  const answers = readAnswers(result);

  const effectivePolicy = policy === undefined || policy === null ? {} : policy;
  if (!isPlainObject(effectivePolicy)) {
    throw new JevConfigError("policy must be an object of questionId -> thresholds.", {
      field: "policy",
    });
  }

  const ids = Object.keys(effectivePolicy);
  if (ids.length === 0) {
    return { decision: "accept", reasons: ["no-policy"], questions: {} };
  }

  const questions = {};
  const outcomes = [];

  for (const id of ids) {
    const answer = answers[id];
    if (answer === undefined || answer === null) {
      outcomes.push({ id, action: "review", reason: `missing:${id}` });
      continue;
    }
    const outcome = evaluateQuestion(id, answer, effectivePolicy[id]);
    questions[id] = outcome.entry;
    outcomes.push({ id, action: outcome.action, reason: outcome.reason });
  }

  const decision = strictest(outcomes.map((outcome) => outcome.action));
  const reasons =
    decision === "accept"
      ? []
      : outcomes
          .filter((outcome) => outcome.action === decision)
          .map((outcome) => outcome.reason ?? outcome.id);

  return { decision, reasons, questions };
}

function evaluateQuestion(id, answer, policyEntry) {
  if (!isPlainObject(policyEntry)) {
    throw new JevConfigError(`policy["${id}"] must be an object.`, { field: `policy.${id}` });
  }
  if (!isPlainObject(answer)) {
    throw new JevParseError(`answer "${id}" must be an object.`, { id });
  }

  const confidence =
    typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
      ? answer.confidence
      : undefined;

  if (typeof answer.choice === "string") {
    return evaluateChoice(id, answer.choice, policyEntry, confidence);
  }

  const numeric =
    typeof answer.noul === "number" && Number.isFinite(answer.noul)
      ? answer.noul
      : typeof answer.score === "number" && Number.isFinite(answer.score)
        ? answer.score
        : null;

  if (numeric === null) {
    throw new JevParseError(`answer "${id}" has no usable noul, choice or score value.`, { id });
  }

  return evaluateNumeric(id, numeric, policyEntry, confidence);
}

function evaluateChoice(id, choice, policyEntry, confidence) {
  const acceptWhen = readStringList(policyEntry.acceptWhen);
  const reviewWhen = readStringList(policyEntry.reviewWhen);
  const entry = withConfidence({ action: "review", value: choice }, confidence);

  if (acceptWhen.length === 0 && reviewWhen.length === 0) {
    return { action: "review", reason: `unconfigured:${id}`, entry };
  }
  // A contradictory policy (same option in both lists) resolves to the stricter one.
  if (reviewWhen.includes(choice)) {
    return { action: "review", entry: withConfidence({ action: "review", value: choice }, confidence) };
  }
  if (acceptWhen.includes(choice)) {
    return { action: "accept", entry: withConfidence({ action: "accept", value: choice }, confidence) };
  }
  return { action: "reject", entry: withConfidence({ action: "reject", value: choice }, confidence) };
}

function evaluateNumeric(id, value, policyEntry, confidence) {
  const acceptAt = finiteOrNull(policyEntry.acceptAt);
  const reviewAt = finiteOrNull(policyEntry.reviewAt);

  if (acceptAt === null && reviewAt === null) {
    return {
      action: "review",
      reason: `unconfigured:${id}`,
      entry: withConfidence({ action: "review", value }, confidence),
    };
  }
  if (acceptAt !== null && value >= acceptAt) {
    return { action: "accept", entry: withConfidence({ action: "accept", value }, confidence) };
  }
  if (reviewAt !== null && value >= reviewAt) {
    return { action: "review", entry: withConfidence({ action: "review", value }, confidence) };
  }
  return { action: "reject", entry: withConfidence({ action: "reject", value }, confidence) };
}

function strictest(actions) {
  for (const action of ["reject", "review"]) {
    if (actions.includes(action)) return action;
  }
  return "accept";
}

function withConfidence(entry, confidence) {
  if (confidence === undefined) return entry;
  return { action: entry.action, value: entry.value, confidence };
}

function readAnswers(result) {
  if (!isPlainObject(result)) {
    throw new JevConfigError("verdict(result, policy) needs a DecisionResult object.", {
      field: "result",
    });
  }
  if (!isPlainObject(result.answers)) {
    throw new JevConfigError("verdict(result, policy) needs result.answers.", {
      field: "result.answers",
    });
  }
  return result.answers;
}

function readStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new JevConfigError(`${field} must be a non-empty string.`, { field });
  }
  return value.trim();
}

function requireTextList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new JevConfigError(`${field} must be a non-empty array of strings.`, { field });
  }
  return value.map((item) => requireText(item, field));
}

function requireChoiceCriteria(criteria) {
  if (Array.isArray(criteria)) {
    return uniqueTextList(criteria, "criteria");
  }
  if (isPlainObject(criteria)) {
    const options = Object.keys(criteria);
    if (options.length === 0) {
      throw new JevConfigError("criteria must name at least one option.", { field: "criteria" });
    }
    for (const option of options) requireText(criteria[option], `criteria.${option}`);
    return { ...criteria };
  }
  throw new JevConfigError(
    "criteria for a choice question must be string[] or { [option]: description }.",
    { field: "criteria" },
  );
}

function requireScoreCriteria(criteria) {
  if (Array.isArray(criteria)) {
    return uniqueTextList(criteria, "criteria");
  }
  if (isPlainObject(criteria)) {
    return { levels: uniqueTextList(criteria.levels, "criteria.levels") };
  }
  throw new JevConfigError("criteria for a score question must be string[] or { levels: string[] }.", {
    field: "criteria",
  });
}

function uniqueTextList(value, field) {
  const list = requireTextList(value, field);
  if (new Set(list).size !== list.length) {
    throw new JevConfigError(`${field} must not repeat an entry.`, { field });
  }
  return list;
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
