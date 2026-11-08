// Decision client for the Jev decision layer.
// Zero runtime dependencies: global fetch, node:crypto, node:fs, node:path.
// Config, defaults and error classes live in ./config.mjs and are never redefined here.

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  QUESTION_TYPES,
  JevConfigError,
  JevParseError,
  JevRequestError,
  resolveConfig,
} from "./config.mjs";

const BACKOFF_BASE_MS = 250;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Ask Jev for one decision over a batch of questions.
 *
 * @param {object} request
 * @param {string|object|Array} request.state
 * @param {object} request.questions
 * @param {string} [request.model]
 * @param {"decisions"|"systemone"} [request.route]
 * @param {string} [request.apiKey]
 * @param {string} [request.baseUrl]
 * @param {number} [request.timeoutMs]
 * @param {number} [request.maxRetries]
 * @param {string} [request.receiptsPath]
 * @param {boolean} [request.includeRaw]
 * @param {object} [options] test seams: { fetchImpl, now, receiptWriter }
 * @returns {Promise<object>} DecisionResult
 */
export async function decide(request, options = {}) {
  if (!isPlainObject(request)) {
    throw new JevConfigError("decide(request) needs a request object.", { field: "request" });
  }

  const config = resolveConfig({
    apiKey: request.apiKey,
    baseUrl: request.baseUrl,
    model: request.model,
    route: request.route,
    timeoutMs: request.timeoutMs,
    maxRetries: request.maxRetries,
    receiptsPath: request.receiptsPath,
  });

  // Fail closed on configuration before any network call.
  if (!config.apiKey) {
    throw new JevConfigError(
      "No Jev API key. Set JEV_API_KEY, JEV_API_KEY_FILE or OPENROUTER_API_KEY, or pass apiKey.",
      { field: "apiKey" },
    );
  }
  if (typeof config.model !== "string" || config.model.trim() === "") {
    throw new JevConfigError("model must be a non-empty string.", { field: "model" });
  }

  const timeoutMs = requireTimeout(config.timeoutMs);
  const maxRetries = requireMaxRetries(config.maxRetries);
  const state = requireState(request.state);
  const questionEntries = requireQuestions(request.questions);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new JevConfigError(
      "No fetch implementation. Pass options.fetchImpl or run on Node 20+.",
      { field: "fetchImpl" },
    );
  }
  const now = typeof options.now === "function" ? options.now : Date.now;

  const body = requireJsonBody({
    model: config.model,
    questions: request.questions,
    state,
  });

  const startedAt = now();
  const { payload, response } = await sendDecision({
    config,
    timeoutMs,
    maxRetries,
    body,
    fetchImpl,
  });

  const answersPayload = readAnswersPayload(payload);
  if (!answersPayload) {
    throw new JevParseError("Jev response has no answers object.", {
      route: config.route,
      reason: "missing-answers",
    });
  }

  const answers = {};
  const missing = [];
  for (const [id, type] of questionEntries) {
    const raw = answersPayload[id];
    if (raw === undefined || raw === null) {
      missing.push(id);
      continue;
    }
    answers[id] = normaliseAnswer(id, raw, type);
  }
  if (missing.length > 0) {
    throw new JevParseError(
      `Jev response is missing answers for: ${missing.join(", ")}.`,
      { missing, route: config.route },
    );
  }

  const latencyMs = Math.max(0, now() - startedAt);
  const usage = readUsage(payload.usage);

  const result = {
    ok: true,
    requestId: readRequestId(payload, response),
    model: readModel(payload, config.model),
    route: config.route,
    answers,
    usage,
    latencyMs,
  };
  if (request.includeRaw === true) {
    result.raw = payload;
  }

  await writeReceipt({
    receiptsPath: config.receiptsPath,
    receiptWriter: options.receiptWriter,
    receipt: buildReceipt({
      startedAt,
      model: result.model,
      route: config.route,
      questionEntries,
      usage,
      latencyMs,
      requestId: result.requestId,
      state,
    }),
  });

  return result;
}

async function sendDecision({ config, timeoutMs, maxRetries, body, fetchImpl }) {
  let attempt = 0;

  for (;;) {
    const signal = AbortSignal.timeout(timeoutMs);
    let response;

    try {
      response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal,
      });
    } catch (error) {
      throw translateFetchError(error, signal);
    }

    const status = typeof response?.status === "number" ? response.status : 0;
    const text = await readResponseText(response);

    if (status === 429 || status >= 500) {
      if (attempt < maxRetries) {
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
        attempt += 1;
        continue;
      }
      throw new JevRequestError(
        `Jev request failed with HTTP ${status} after ${attempt + 1} attempt(s).`,
        {
          status,
          reason: "retry-exhausted",
          attempts: attempt + 1,
          body: clip(text),
        },
      );
    }

    if (status < 200 || status >= 300) {
      // 4xx other than 429 is a caller problem: never retry it.
      throw new JevRequestError(`Jev request failed with HTTP ${status}.`, {
        status,
        reason: "http",
        attempts: attempt + 1,
        body: clip(text),
      });
    }

    return { payload: parsePayload(text, status), response };
  }
}

function translateFetchError(error, signal) {
  const name = error?.name;
  const code = error?.code;
  const timedOut =
    signal?.aborted === true ||
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "ETIMEDOUT" ||
    code === "ABORT_ERR";

  if (timedOut) {
    return new JevRequestError("Jev request timed out.", { reason: "timeout" });
  }
  return new JevRequestError(`Jev request failed: ${error?.message ?? String(error)}`, {
    reason: "network",
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readResponseText(response) {
  if (response && typeof response.text === "function") {
    return await response.text();
  }
  if (response && typeof response.json === "function") {
    try {
      return JSON.stringify(await response.json());
    } catch {
      return "";
    }
  }
  return "";
}

function parsePayload(text, status) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new JevParseError("Jev response is not valid JSON.", {
      status,
      reason: "invalid-json",
      body: clip(text),
    });
  }
  if (!isPlainObject(payload)) {
    throw new JevParseError("Jev response must be a JSON object.", {
      status,
      reason: "not-an-object",
    });
  }
  return payload;
}

function readAnswersPayload(payload) {
  const candidates = [
    payload.answers,
    payload.decisions,
    payload.results,
    payload.outputs,
    isPlainObject(payload.data) ? payload.data.answers : undefined,
  ];
  for (const candidate of candidates) {
    if (isPlainObject(candidate)) return candidate;
  }
  return null;
}

function normaliseAnswer(id, raw, type) {
  if (!isPlainObject(raw)) {
    throw new JevParseError(`Answer "${id}" must be an object.`, { id, type });
  }
  if (raw.type !== undefined && raw.type !== type) {
    throw new JevParseError(
      `Answer "${id}" declares type "${raw.type}" but the question type is "${type}".`,
      { id, type, declaredType: raw.type },
    );
  }

  if (type === "noul") {
    const value = finiteOrNull(raw.noul);
    if (value === null || value < 0 || value > 1) {
      throw new JevParseError(
        `Answer "${id}" needs a finite noul value in [0, 1].`,
        { id, type },
      );
    }
    return { type, noul: value };
  }

  if (type === "score") {
    const value = finiteOrNull(raw.score);
    if (value === null) {
      throw new JevParseError(`Answer "${id}" needs a finite score.`, { id, type });
    }
    return { type, score: value, confidence: readConfidence(id, raw.confidence, 0) };
  }

  const choice = raw.choice;
  if (typeof choice !== "string" || choice.trim() === "") {
    throw new JevParseError(`Answer "${id}" needs a choice string.`, { id, type });
  }
  const probabilities = readProbabilities(id, raw.probabilities);
  const fallback = Object.hasOwn(probabilities, choice) ? probabilities[choice] : 0;
  return {
    type,
    choice,
    probabilities,
    confidence: readConfidence(id, raw.confidence, fallback),
  };
}

function readProbabilities(id, raw) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    throw new JevParseError(`Answer "${id}" probabilities must be an object.`, { id });
  }
  const probabilities = {};
  for (const [option, value] of Object.entries(raw)) {
    const probability = finiteOrNull(value);
    if (probability === null || probability < 0 || probability > 1) {
      throw new JevParseError(
        `Answer "${id}" probability for "${option}" must be a finite number in [0, 1].`,
        { id, option },
      );
    }
    probabilities[option] = probability;
  }
  return probabilities;
}

function readConfidence(id, value, fallback) {
  if (value === undefined || value === null) return fallback;
  const confidence = finiteOrNull(value);
  if (confidence === null || confidence < 0 || confidence > 1) {
    throw new JevParseError(
      `Answer "${id}" confidence must be a finite number in [0, 1].`,
      { id },
    );
  }
  return confidence;
}

function readUsage(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    inputTokens: finiteOrNull(
      source.inputTokens ?? source.input_tokens ?? source.prompt_tokens ?? source.promptTokens,
    ),
    outputTokens: finiteOrNull(
      source.outputTokens ??
        source.output_tokens ??
        source.completion_tokens ??
        source.completionTokens,
    ),
    costUsd: finiteOrNull(
      source.costUsd ?? source.cost ?? source.total_cost ?? source.totalCost,
    ),
  };
}

function readRequestId(payload, response) {
  for (const key of ["request_id", "requestId", "id", "decision_id", "decisionId"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const header = headerValue(response, "x-request-id");
  return typeof header === "string" && header.trim() !== "" ? header : null;
}

function readModel(payload, fallback) {
  for (const value of [payload.model, payload.modelId, payload.model_id]) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return fallback;
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : headers[key];
}

function buildReceipt({ startedAt, model, route, questionEntries, usage, latencyMs, requestId, state }) {
  // Metadata only. Never the key, the state body or the questions' instruction text.
  return {
    timestamp: new Date(startedAt).toISOString(),
    model,
    route,
    questions: questionEntries.map(([id, type]) => ({ id, type })),
    usage,
    costUsd: usage.costUsd,
    latencyMs,
    requestId,
    stateSha256: sha256State(state),
  };
}

async function writeReceipt({ receiptsPath, receiptWriter, receipt }) {
  if (typeof receiptWriter === "function") {
    await receiptWriter(receipt);
    return;
  }
  if (!receiptsPath) return;

  await mkdir(dirname(receiptsPath), { recursive: true });
  await appendFile(receiptsPath, `${JSON.stringify(receipt)}\n`, "utf8");
}

function sha256State(state) {
  const serialised = typeof state === "string" ? state : JSON.stringify(state);
  return createHash("sha256").update(serialised).digest("hex");
}

function requireState(state) {
  if (state === undefined || state === null) {
    throw new JevRequestError("state is required.", { field: "state", reason: "empty-state" });
  }
  if (typeof state === "string") {
    if (state.trim() === "") {
      throw new JevRequestError("state must not be an empty string.", {
        field: "state",
        reason: "empty-state",
      });
    }
    return state;
  }
  if (Array.isArray(state)) {
    if (state.length === 0) {
      throw new JevRequestError("state must not be an empty array.", {
        field: "state",
        reason: "empty-state",
      });
    }
    return state;
  }
  if (isPlainObject(state)) {
    if (Object.keys(state).length === 0) {
      throw new JevRequestError("state must not be an empty object.", {
        field: "state",
        reason: "empty-state",
      });
    }
    return state;
  }
  throw new JevRequestError("state must be a string, object or array.", {
    field: "state",
    reason: "invalid-state",
  });
}

function requireQuestions(questions) {
  if (!isPlainObject(questions)) {
    throw new JevRequestError(
      "questions must be a non-empty object of id -> question.",
      { field: "questions" },
    );
  }
  const entries = Object.entries(questions);
  if (entries.length === 0) {
    throw new JevRequestError("questions must contain at least one question.", {
      field: "questions",
      reason: "empty-questions",
    });
  }

  const result = [];
  for (const [id, question] of entries) {
    if (id.trim() === "") {
      throw new JevRequestError("question ids must be non-empty strings.", { field: "questions" });
    }
    if (!isPlainObject(question)) {
      throw new JevRequestError(`question "${id}" must be an object.`, {
        field: `questions.${id}`,
      });
    }
    if (!QUESTION_TYPES.includes(question.type)) {
      throw new JevRequestError(
        `question "${id}" has unsupported type "${question.type}". Use one of: ${QUESTION_TYPES.join(", ")}.`,
        { field: `questions.${id}.type`, type: question.type },
      );
    }
    result.push([id, question.type]);
  }
  return result;
}

function requireJsonBody(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new JevRequestError(`state and questions must be JSON-serialisable: ${error.message}`, {
      field: "state",
      reason: "not-serialisable",
    });
  }
}

function requireTimeout(value) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new JevConfigError(
      `timeoutMs must be an integer between 1 and ${MAX_TIMER_MS}.`,
      { field: "timeoutMs", value },
    );
  }
  return value;
}

function requireMaxRetries(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new JevConfigError("maxRetries must be an integer >= 0.", {
      field: "maxRetries",
      value,
    });
  }
  return value;
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clip(text) {
  if (typeof text !== "string") return null;
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
