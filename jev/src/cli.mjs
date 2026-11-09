#!/usr/bin/env node
// jev command line. Zero runtime dependencies.
//
// Contract (see jev/CONTRACT.md):
//   stdout carries exactly one JSON document per invocation, errors and help
//   included, so a caller can always JSON.parse it.
//   stderr carries human diagnostics, remediation text and verdict summaries.
//   Exit codes: 0 accept, 3 review or reject (escalation), 2 usage or config
//   error, 1 request or parse error.
//
// Test seam: `main(argv, deps)` returns the exit code instead of exiting and
// accepts { decideImpl, readFileImpl, writeImpl }. Two optional extras exist
// for tests that would otherwise need a network or a checkout: readStdinImpl
// (the `-` input path) and verdictImpl (policy escalation without questions.mjs
// being present). Nothing else is injected in production.
//
// src/client.mjs and src/questions.mjs are imported lazily and only on the
// `decide` path, so help/check/policies keep working before the core lands.

import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JevConfigError, describeConfig, resolveConfig } from "./config.mjs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = resolve(SRC_DIR, "..");
export const POLICIES_DIR = resolve(PACKAGE_ROOT, "policies");

// Never printed as a value; only names the places a key may come from.
export const KEY_REMEDIATION =
  "Set OPENROUTER_API_KEY (or JEV_API_KEY) in the environment, or point JEV_API_KEY_FILE at a file that contains the key.";

// Policy ids are bare file names from jev/policies. No separators, no `..`.
export const POLICY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const COMMANDS = Object.freeze([
  {
    name: "decide",
    summary: "Ask Jev one or more typed questions about a state.",
    usage:
      "decide --state <path|-> --questions <path|-> [--policy <id>] [--model <id>] [--route decisions|systemone] [--receipts <path>] [--include-raw]",
  },
  { name: "check", summary: "Print the resolved config and whether a key is present. No network.", usage: "check" },
  { name: "policies", summary: "List the packaged policy files with their id and description.", usage: "policies" },
  { name: "help", summary: "Print this usage.", usage: "help" },
]);

export const USAGE = [
  "jev <command> [options]",
  "",
  "Commands:",
  ...COMMANDS.map((command) => `  ${command.summary}\n      jev ${command.usage}`),
  "",
  "Output: stdout is one JSON document; diagnostics go to stderr.",
  "Exit codes: 0 accept | 3 review or reject (escalation) | 2 usage or config | 1 request or parse",
].join("\n");

class CliUsageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CliUsageError";
    this.code = "JEV_USAGE";
    this.details = details;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultWrite(text, stream = "stdout") {
  const target = stream === "stderr" ? process.stderr : process.stdout;
  target.write(text);
}

function emit(write, payload, stream = "stdout") {
  write(`${JSON.stringify(payload, null, 2)}\n`, stream);
}

function diagnose(write, lines) {
  const text = (Array.isArray(lines) ? lines : [lines]).filter((line) => typeof line === "string" && line !== "").join("\n");
  if (text !== "") write(`${text}\n`, "stderr");
}

export function exitCodeForVerdict(decision) {
  return decision === "accept" ? 0 : 3;
}

function exitCodeForError(error) {
  const code = error?.code ?? "";
  if (error?.name === "JevConfigError" || code === "JEV_CONFIG" || code === "JEV_USAGE") return 2;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNSUPPORTED_ESM_URL_SCHEME") return 2;
  return 1;
}

function looksLikeKeyProblem(error) {
  return /key|credential|token/i.test(String(error?.message ?? ""));
}

function errorPayload(error) {
  const code = error?.code ?? error?.name ?? "JEV_ERROR";
  const payload = { ok: false, error: { code, message: error?.message ?? String(error) } };
  if (isPlainObject(error?.details) && Object.keys(error.details).length > 0) {
    payload.error.details = error.details;
  }
  return payload;
}

export function parseArgv(argv = []) {
  const takesValue = new Set(["--state", "--questions", "--policy", "--model", "--route", "--receipts"]);
  const booleans = new Set(["--include-raw", "--help", "-h", "--json"]);
  const flags = {};
  const positionals = [];
  const errors = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);

    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const separator = token.indexOf("=");
    const name = separator === -1 ? token : token.slice(0, separator);
    const inline = separator === -1 ? undefined : token.slice(separator + 1);

    if (booleans.has(name)) {
      flags[name] = true;
      continue;
    }

    if (!takesValue.has(name)) {
      errors.push(`Unknown flag "${name}".`);
      continue;
    }

    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined || (String(next).startsWith("-") && String(next) !== "-")) {
      errors.push(`Flag "${name}" needs a value.`);
      continue;
    }

    flags[name] = String(next);
    index += 1;
  }

  return { flags, positionals, errors };
}

async function defaultReadStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadCoreModule(specifier, exportName) {
  let module;
  try {
    module = await import(specifier);
  } catch (error) {
    throw new JevConfigError(
      `Cannot load ${specifier} (${error?.code ?? error?.message}). The Jev core is incomplete in this checkout.`,
    );
  }
  if (typeof module[exportName] !== "function") {
    throw new JevConfigError(`${specifier} does not export ${exportName}().`);
  }
  return module[exportName];
}

async function defaultDecide(request, options) {
  const decide = await loadCoreModule("./client.mjs", "decide");
  return decide(request, options);
}

async function defaultVerdict(result, policy) {
  const verdict = await loadCoreModule("./questions.mjs", "verdict");
  return verdict(result, policy);
}

async function readJsonInput(spec, label, io) {
  const source = spec === "-" ? "stdin" : spec;
  const raw = spec === "-" ? await io.readStdin() : await io.readFile(spec);

  if (typeof raw !== "string") {
    throw new CliUsageError(`${label}: expected text from ${source}.`);
  }
  if (raw.trim() === "") {
    throw new CliUsageError(`${label}: no input on ${source}.`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(`${label}: invalid JSON in ${source} (${error.message}).`);
  }
}

// Policy documents ship in two shapes: the contract's flat
// `{ questionId: thresholds }` and the packaged document form
// `{ id, description, questions, policy: { questionId: thresholds } }`.
// verdict() only understands the flat form, so unwrap it here.
const POLICY_META_KEYS = new Set(["id", "description", "title", "version", "notes", "model", "questions"]);

export function policyThresholds(document) {
  if (!isPlainObject(document)) return {};

  const wrapped = document.policy;
  if (isPlainObject(wrapped) && Object.keys(wrapped).length > 0) return wrapped;

  const flat = {};
  for (const [key, value] of Object.entries(document)) {
    if (POLICY_META_KEYS.has(key)) continue;
    if (!isPlainObject(value)) continue;
    flat[key] = value;
  }
  return flat;
}

async function readPolicyDocument(id, readFileImpl) {
  const policyId = String(id ?? "").trim();

  if (policyId === "") throw new CliUsageError("--policy needs a policy id.");

  if (!POLICY_ID_PATTERN.test(policyId)) {
    throw new CliUsageError(
      `Invalid policy id "${policyId}". Use a bare file name from jev/policies (letters, digits, dot, dash, underscore).`,
    );
  }

  const path = resolve(POLICIES_DIR, `${policyId}.json`);

  let raw;
  try {
    raw = await readFileImpl(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new JevConfigError(`Unknown policy "${policyId}": no file at ${path}. Run: jev policies`);
    }
    throw new JevConfigError(`Cannot read policy "${policyId}" from ${path}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new JevConfigError(`Policy "${policyId}" is not valid JSON: ${error.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new JevConfigError(`Policy "${policyId}" must be a JSON object of questionId -> thresholds.`);
  }

  return { policyId, parsed };
}

export async function loadPolicy(id, readFileImpl = (path) => readFile(path, "utf8")) {
  const { policyId, parsed } = await readPolicyDocument(id, readFileImpl);

  const thresholds = policyThresholds(parsed);
  if (Object.keys(thresholds).length === 0) {
    throw new JevConfigError(`Policy "${policyId}" declares no question thresholds.`);
  }

  return thresholds;
}

// A shipped policy carries both its questions and its bands. Until now only the bands were
// reachable, so every policy listed by `jev policies` needed a hand-written questions file
// before it could run. The questions block is the policy; let --policy stand alone.
export async function loadPolicyQuestions(id, readFileImpl = (path) => readFile(path, "utf8")) {
  const { policyId, parsed } = await readPolicyDocument(id, readFileImpl);

  const questions = isPlainObject(parsed.questions) ? parsed.questions : null;
  if (!questions || Object.keys(questions).length === 0) {
    throw new JevConfigError(`Policy "${policyId}" declares no questions block. Pass --questions as well.`);
  }

  return questions;
}

export async function listPolicies(readFileImpl = (path) => readFile(path, "utf8")) {
  let entries;
  try {
    entries = await readdir(POLICIES_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const policies = [];
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    const path = resolve(POLICIES_DIR, file);
    let description = null;
    let entries_ = null;

    try {
      const parsed = JSON.parse(await readFileImpl(path));
      if (isPlainObject(parsed)) {
        if (typeof parsed.description === "string") description = parsed.description;
        else if (typeof parsed.title === "string") description = parsed.title;
        entries_ = Object.keys(policyThresholds(parsed)).length;
      }
    } catch {
      // A broken policy file still lists; the description stays null and the
      // caller discovers the problem when it loads that id.
      description = null;
    }

    policies.push({ id, description, path, entries: entries_ });
  }

  return policies;
}

async function runHelp(io) {
  emit(io.write, {
    ok: true,
    usage: USAGE,
    commands: COMMANDS.map((command) => ({ name: command.name, summary: command.summary, usage: command.usage })),
  });
  // Humans read the terminal; machines read stdout. Usage is diagnostics.
  diagnose(io.write, USAGE);
  return 0;
}

async function runCheck(io) {
  let payload;
  try {
    const config = resolveConfig({});
    payload = { ok: true, ...describeConfig(config), ready: Boolean(config.apiKey) };
  } catch (error) {
    payload = {
      ok: false,
      ready: false,
      error: { code: error?.code ?? "JEV_CONFIG", message: error?.message ?? String(error) },
    };
  }

  emit(io.write, payload);

  if (!payload.ready) {
    diagnose(io.write, ["jev is not ready: no API key resolved.", KEY_REMEDIATION]);
  }

  return 0;
}

async function runPolicies(io) {
  try {
    const policies = await listPolicies(io.readFile);
    emit(io.write, { ok: true, policies, count: policies.length });
    return 0;
  } catch (error) {
    diagnose(io.write, `jev policies: ${error?.message ?? String(error)}`);
    emit(io.write, errorPayload(error));
    return exitCodeForError(error);
  }
}

async function runDecide(parsed, io, deps) {
  const { flags } = parsed;

  const stateSpec = flags["--state"];
  const questionsSpec = flags["--questions"];

  if (!stateSpec || (!questionsSpec && flags["--policy"] === undefined)) {
    const message = questionsSpec
      ? "decide needs both --state and --questions (use - for stdin)."
      : "decide needs both --state and --questions, or --state with --policy (use - for stdin).";
    diagnose(io.write, [message, USAGE]);
    emit(io.write, { ok: false, error: { code: "JEV_USAGE", message } });
    return 2;
  }

  // Config first, on purpose: reading stdin for a call that cannot succeed
  // would block a terminal.
  let config;
  try {
    config = resolveConfig({
      model: flags["--model"],
      route: flags["--route"],
      receiptsPath: flags["--receipts"],
    });
  } catch (error) {
    diagnose(io.write, [error?.message, KEY_REMEDIATION]);
    emit(io.write, { ...errorPayload(error), remediation: KEY_REMEDIATION });
    return 2;
  }

  if (!config.apiKey) {
    const message = "No API key resolved for jev decide.";
    diagnose(io.write, [message, KEY_REMEDIATION]);
    emit(io.write, { ok: false, error: { code: "JEV_CONFIG", message }, remediation: KEY_REMEDIATION });
    return 2;
  }

  let state;
  let questions;
  try {
    state = await readJsonInput(stateSpec, "--state", io);
    questions = questionsSpec
      ? await readJsonInput(questionsSpec, "--questions", io)
      : await loadPolicyQuestions(flags["--policy"], io.readFile);
  } catch (error) {
    diagnose(io.write, error?.message ?? String(error));
    emit(io.write, errorPayload(error));
    return exitCodeForError(error);
  }

  let policy = null;
  if (flags["--policy"] !== undefined) {
    try {
      policy = await loadPolicy(flags["--policy"], io.readFile);
    } catch (error) {
      diagnose(io.write, error?.message ?? String(error));
      emit(io.write, errorPayload(error));
      return exitCodeForError(error);
    }
  }

  const request = { state, questions, model: config.model, route: config.route };
  if (config.receiptsPath) request.receiptsPath = config.receiptsPath;
  if (flags["--include-raw"] === true) request.includeRaw = true;

  let result;
  try {
    result = await (deps.decideImpl ?? defaultDecide)(request, {});
  } catch (error) {
    const exitCode = exitCodeForError(error);
    diagnose(io.write, [error?.message ?? String(error), exitCode === 2 && looksLikeKeyProblem(error) ? KEY_REMEDIATION : null]);
    emit(io.write, errorPayload(error));
    return exitCode;
  }

  if (!isPlainObject(result)) {
    const message = "decide() returned no decision result.";
    diagnose(io.write, message);
    emit(io.write, { ok: false, error: { code: "JEV_PARSE", message } });
    return 1;
  }

  let payload = result;
  let exitCode = result.ok === false ? 1 : 0;

  if (policy) {
    let verdict;
    try {
      verdict = await (deps.verdictImpl ?? defaultVerdict)(result, policy);
    } catch (error) {
      diagnose(io.write, `verdict failed: ${error?.message ?? String(error)}`);
      emit(io.write, errorPayload(error));
      return exitCodeForError(error);
    }

    payload = { ...result, verdict };
    exitCode = exitCodeForVerdict(verdict?.decision);
    const reasons = Array.isArray(verdict?.reasons) && verdict.reasons.length > 0 ? ` (${verdict.reasons.join(", ")})` : "";
    diagnose(io.write, `verdict: ${verdict?.decision ?? "unknown"}${reasons}`);
  } else {
    const answered = Object.keys(result.answers ?? {}).length;
    const latency = result.latencyMs === undefined ? "" : ` in ${result.latencyMs}ms`;
    diagnose(io.write, `decided ${answered} question(s)${latency} via ${result.route ?? config.route}.`);
  }

  emit(io.write, payload);
  return exitCode;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const io = {
    write: deps.writeImpl ?? defaultWrite,
    readFile: deps.readFileImpl ?? ((path) => readFile(path, "utf8")),
    readStdin: deps.readStdinImpl ?? defaultReadStdin,
  };

  const parsed = parseArgv(argv);
  const command = String(parsed.positionals[0] ?? "").trim().toLowerCase();
  const wantsHelp = parsed.flags["--help"] === true || parsed.flags["-h"] === true;

  if (wantsHelp || command === "help") return runHelp(io);

  if (command === "") {
    const message = "No command given.";
    diagnose(io.write, [message, USAGE]);
    emit(io.write, { ok: false, error: { code: "JEV_USAGE", message } });
    return 2;
  }

  if (parsed.errors.length > 0) {
    const message = parsed.errors.join(" ");
    diagnose(io.write, [message, USAGE]);
    emit(io.write, { ok: false, error: { code: "JEV_USAGE", message }, details: parsed.errors });
    return 2;
  }

  if (parsed.positionals.length > 1) {
    const message = `Unexpected argument "${parsed.positionals[1]}".`;
    diagnose(io.write, [message, USAGE]);
    emit(io.write, { ok: false, error: { code: "JEV_USAGE", message } });
    return 2;
  }

  if (command === "check") return runCheck(io);
  if (command === "policies") return runPolicies(io);
  if (command === "decide") return runDecide(parsed, io, deps);

  const message = `Unknown command "${parsed.positionals[0]}". Try: jev help`;
  diagnose(io.write, [message, USAGE]);
  emit(io.write, { ok: false, error: { code: "JEV_USAGE", message } });
  return 2;
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    const invoked = resolve(entry);
    return process.platform === "win32"
      ? self.toLowerCase() === invoked.toLowerCase()
      : self === invoked;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`jev: ${error?.message ?? String(error)}\n`);
      process.exitCode = 1;
    });
}
