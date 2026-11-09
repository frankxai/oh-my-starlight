// Shared runtime configuration for the Jev decision layer.
// Zero dependencies. Every module resolves config through this file so the CLI,
// the MCP server and library callers cannot drift apart.

import { readFileSync } from "node:fs";

export const DEFAULTS = Object.freeze({
  baseUrl: "https://openrouter.ai/api",
  route: "decisions", // "decisions" -> /alpha/decisions ; "systemone" -> /v1/systemone
  model: "typesafe/jev-1.13",
  timeoutMs: 20_000,
  maxRetries: 2,
  receiptsPath: null,
});

export const ROUTE_PATHS = Object.freeze({
  decisions: "/alpha/decisions",
  systemone: "/v1/systemone",
});

export const QUESTION_TYPES = Object.freeze(["noul", "choice", "score"]);

export class JevConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "JevConfigError";
    this.code = "JEV_CONFIG";
    this.details = details;
  }
}

export class JevRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "JevRequestError";
    this.code = "JEV_REQUEST";
    this.details = details;
  }
}

export class JevParseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "JevParseError";
    this.code = "JEV_PARSE";
    this.details = details;
  }
}

function env(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function intEnv(name, fallback) {
  const raw = env(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Resolve the API key without ever logging it. Key precedence is explicit:
//   1. caller-supplied apiKey
//   2. JEV_API_KEY
//   3. JEV_API_KEY_FILE (path to a file containing the key)
//   4. OPENROUTER_API_KEY   (default route: the Decisions API is billed there)
//   5. TYPESAFE_API_KEY     (only meaningful when JEV_BASE_URL points at TypeSafe)
export function resolveApiKey(override) {
  if (override && String(override).trim() !== "") {
    return { apiKey: String(override).trim(), source: "override" };
  }

  const direct = env("JEV_API_KEY");
  if (direct) return { apiKey: direct, source: "JEV_API_KEY" };

  const keyFile = env("JEV_API_KEY_FILE");
  if (keyFile) {
    try {
      const contents = readFileSync(keyFile, "utf8").trim();
      if (contents !== "") return { apiKey: contents, source: "JEV_API_KEY_FILE" };
    } catch (error) {
      throw new JevConfigError(`JEV_API_KEY_FILE is set but unreadable: ${error.message}`, { path: keyFile });
    }
  }

  const openrouter = env("OPENROUTER_API_KEY");
  if (openrouter) return { apiKey: openrouter, source: "OPENROUTER_API_KEY" };

  const typesafe = env("TYPESAFE_API_KEY");
  if (typesafe) return { apiKey: typesafe, source: "TYPESAFE_API_KEY" };

  return { apiKey: null, source: "none" };
}

export function normalizeRoute(route = DEFAULTS.route) {
  const value = String(route || DEFAULTS.route).toLowerCase();
  if (!ROUTE_PATHS[value]) {
    throw new JevConfigError(`Unknown route "${route}". Use one of: ${Object.keys(ROUTE_PATHS).join(", ")}.`);
  }
  return value;
}

export function buildEndpoint(baseUrl, route) {
  const trimmed = String(baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "");
  return `${trimmed}${ROUTE_PATHS[normalizeRoute(route)]}`;
}

export function resolveConfig(overrides = {}) {
  const { apiKey, source } = resolveApiKey(overrides.apiKey);
  const route = normalizeRoute(overrides.route ?? env("JEV_ROUTE") ?? DEFAULTS.route);
  const baseUrl = overrides.baseUrl ?? env("JEV_BASE_URL") ?? DEFAULTS.baseUrl;

  if (source === "TYPESAFE_API_KEY" && !overrides.baseUrl && !env("JEV_BASE_URL")) {
    throw new JevConfigError(
      "TYPESAFE_API_KEY is set but JEV_BASE_URL is not. Point JEV_BASE_URL at the TypeSafe endpoint, or set OPENROUTER_API_KEY to use the OpenRouter Decisions API.",
    );
  }

  return {
    apiKey,
    keySource: source,
    route,
    baseUrl,
    endpoint: buildEndpoint(baseUrl, route),
    model: overrides.model ?? env("JEV_MODEL") ?? DEFAULTS.model,
    timeoutMs: overrides.timeoutMs ?? intEnv("JEV_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxRetries: overrides.maxRetries ?? intEnv("JEV_MAX_RETRIES", DEFAULTS.maxRetries),
    receiptsPath: overrides.receiptsPath ?? env("JEV_RECEIPTS_PATH") ?? DEFAULTS.receiptsPath,
  };
}

// A config summary safe to print: never includes the key itself.
export function describeConfig(config) {
  return {
    endpoint: config.endpoint,
    route: config.route,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    receiptsPath: config.receiptsPath,
    key: {
      present: Boolean(config.apiKey),
      source: config.keySource,
    },
  };
}
