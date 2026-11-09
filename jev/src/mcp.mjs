#!/usr/bin/env node
// jev MCP server: stdio transport, three read-only tools.
//
// The SDK is a real optional dependency, so it is imported lazily and a missing
// install is an install instruction on stderr plus exit 2, never a stack trace.
// Nothing here writes to disk and nothing here writes to stdout except the MCP
// protocol itself.
//
// Policy file IO lives in ./cli.mjs (listPolicies / loadPolicy) so the CLI and
// the server cannot disagree about what a policy id means.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JevConfigError, describeConfig, resolveConfig } from "./config.mjs";
import { KEY_REMEDIATION, loadPolicy, listPolicies } from "./cli.mjs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = resolve(SRC_DIR, "..");

const PACKAGE = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"));

export const SERVER_NAME = "jev";
export const SERVER_VERSION = typeof PACKAGE.version === "string" ? PACKAGE.version : "0.0.0";

export const MCP_SDK_MISSING_MESSAGE = `MCP SDK missing. Run: npm install --prefix ${PACKAGE_ROOT} @modelcontextprotocol/sdk`;

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "jev_decide",
    title: "Jev decide",
    description:
      "Ask Jev (TypeSafe System One, reached through the OpenRouter Decisions API) to answer typed questions about a state. " +
      "Send `state` (a diff, document, plan, CI log or any JSON payload) and `questions` (an object of id -> question, where each " +
      "question is a no/unknown-likelihood question, a choice or a score). Returns the DecisionResult as JSON. Pass `policy` " +
      "(an id from jev_policies or an inline policy object) to also get a `verdict` of accept, review or reject. " +
      "Requires OPENROUTER_API_KEY, JEV_API_KEY or JEV_API_KEY_FILE in the server environment.",
    // Read-only in the MCP sense: no filesystem writes, no side effects beyond
    // the model call. The shared tool plane stamps the same claim.
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        state: {
          description: "What to judge: a git diff, a document, a plan, a CI log, or any JSON value (string, object or array).",
          type: ["string", "object", "array"],
        },
        questions: {
          description:
            "Map of question id -> question. A question is { type: 'noul' | 'choice' | 'score', instructions, criteria }.",
          type: "object",
          additionalProperties: { type: "object" },
        },
        model: {
          description: "Override the model id. Defaults to the server config (JEV_MODEL, then typesafe/jev-1.13).",
          type: "string",
        },
        route: {
          description: "Which Jev route to call. Defaults to the server config.",
          type: "string",
          enum: ["decisions", "systemone"],
        },
        policy: {
          description:
            "Optional policy id shipped in jev/policies, or an inline policy object mapping questionId -> thresholds.",
          oneOf: [{ type: "string" }, { type: "object" }],
        },
      },
      required: ["state", "questions"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_check",
    title: "Jev check",
    description:
      "Report the resolved Jev configuration (endpoint, route, model, timeouts, receipts path, key source) and whether a usable " +
      "API key is present. No network call and no filesystem write.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "jev_policies",
    title: "Jev policies",
    description:
      "List the policy files shipped in jev/policies with id, description and path, so an id can be passed as `policy` to jev_decide.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toolError(message, meta = {}) {
  const payload = { ok: false, error: { code: meta.code ?? "JEV_ERROR", message } };
  if (isPlainObject(meta.details) && Object.keys(meta.details).length > 0) payload.error.details = meta.details;
  if (meta.remediation) payload.remediation = meta.remediation;
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

function looksLikeKeyProblem(error) {
  return /key|credential|token/i.test(String(error?.message ?? ""));
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

async function callCheck() {
  try {
    const config = resolveConfig({});
    return textResult({ ok: true, ...describeConfig(config), ready: Boolean(config.apiKey) });
  } catch (error) {
    return textResult({
      ok: false,
      ready: false,
      error: { code: error?.code ?? "JEV_CONFIG", message: error?.message ?? String(error) },
    });
  }
}

async function callPolicies(deps) {
  try {
    const policies = await listPolicies(deps.readFileImpl);
    return textResult({ ok: true, policies, count: policies.length });
  } catch (error) {
    return toolError(`Cannot list policies: ${error?.message ?? String(error)}`, { code: error?.code ?? "JEV_ERROR" });
  }
}

async function callDecide(args, deps) {
  if (args.state === undefined || args.state === null) {
    return toolError("jev_decide needs `state` (a diff, document, plan or JSON payload).", { code: "JEV_USAGE" });
  }
  if (args.questions === undefined || args.questions === null) {
    return toolError("jev_decide needs `questions` (an object of id -> question).", { code: "JEV_USAGE" });
  }

  let config;
  try {
    config = resolveConfig({
      model: typeof args.model === "string" ? args.model : undefined,
      route: typeof args.route === "string" ? args.route : undefined,
    });
  } catch (error) {
    return toolError(error?.message ?? String(error), {
      code: error?.code ?? "JEV_CONFIG",
      details: error?.details,
      remediation: looksLikeKeyProblem(error) ? KEY_REMEDIATION : undefined,
    });
  }

  if (!config.apiKey) {
    return toolError("No API key resolved for jev_decide.", {
      code: "JEV_CONFIG",
      remediation: KEY_REMEDIATION,
    });
  }

  let policy = null;
  if (args.policy !== undefined && args.policy !== null) {
    if (typeof args.policy === "string") {
      try {
        policy = await loadPolicy(args.policy, deps.readFileImpl);
      } catch (error) {
        return toolError(error?.message ?? String(error), { code: error?.code ?? "JEV_CONFIG" });
      }
    } else if (isPlainObject(args.policy)) {
      policy = args.policy;
    } else {
      return toolError("`policy` must be a policy id string or a policy object.", { code: "JEV_USAGE" });
    }
  }

  let result;
  try {
    result = await (deps.decideImpl ?? defaultDecide)(
      { state: args.state, questions: args.questions, model: config.model, route: config.route },
      {},
    );
  } catch (error) {
    return toolError(error?.message ?? String(error), {
      code: error?.code ?? "JEV_ERROR",
      details: error?.details,
      remediation: looksLikeKeyProblem(error) ? KEY_REMEDIATION : undefined,
    });
  }

  if (!isPlainObject(result)) {
    return toolError("decide() returned no decision result.", { code: "JEV_PARSE" });
  }

  if (!policy) return textResult(result);

  let verdict;
  try {
    verdict = await (deps.verdictImpl ?? defaultVerdict)(result, policy);
  } catch (error) {
    return toolError(`verdict failed: ${error?.message ?? String(error)}`, { code: error?.code ?? "JEV_ERROR" });
  }

  return textResult({ ...result, verdict });
}

// Exported so tests can assert tool behaviour without a transport.
export async function callTool(name, args = {}, deps = {}) {
  switch (name) {
    case "jev_decide":
      return callDecide(isPlainObject(args) ? args : {}, deps);
    case "jev_check":
      return callCheck();
    case "jev_policies":
      return callPolicies(deps);
    default:
      return toolError(`Unknown tool "${name}". Available: jev_decide, jev_check, jev_policies.`, { code: "JEV_USAGE" });
  }
}

let sdkCache;

// undefined = not attempted, null = unavailable, object = loaded.
export async function loadSdk() {
  if (sdkCache !== undefined) return sdkCache;

  try {
    const [server, stdio, types] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);

    if (
      typeof server.Server === "function" &&
      typeof stdio.StdioServerTransport === "function" &&
      types.ListToolsRequestSchema &&
      types.CallToolRequestSchema
    ) {
      sdkCache = {
        Server: server.Server,
        StdioServerTransport: stdio.StdioServerTransport,
        ListToolsRequestSchema: types.ListToolsRequestSchema,
        CallToolRequestSchema: types.CallToolRequestSchema,
      };
    } else {
      sdkCache = null;
    }
  } catch {
    sdkCache = null;
  }

  return sdkCache;
}

export async function createServer(options = {}) {
  const sdk = options.sdk ?? (await loadSdk());

  if (!sdk) {
    const error = new Error(MCP_SDK_MISSING_MESSAGE);
    error.code = "JEV_MCP_SDK_MISSING";
    throw error;
  }

  const server = new sdk.Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(sdk.CallToolRequestSchema, async (request) => {
    const params = request?.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = isPlainObject(params.arguments) ? params.arguments : {};
    return callTool(name, args, options.deps ?? {});
  });

  return server;
}

async function startServer() {
  const sdk = await loadSdk();

  if (!sdk) {
    process.stderr.write(`${MCP_SDK_MISSING_MESSAGE}\n`);
    return 2;
  }

  const server = await createServer({ sdk });
  await server.connect(new sdk.StdioServerTransport());
  return 0;
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    const invoked = resolve(entry);
    return process.platform === "win32" ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  startServer()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // Never a stack trace: MCP clients surface stderr to users.
      process.stderr.write(`jev mcp: ${error?.message ?? String(error)}\n`);
      process.exitCode = 1;
    });
}
