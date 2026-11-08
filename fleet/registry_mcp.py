#!/usr/bin/env python3
"""Starlight registry MCP server: the measured harness index as a tool.

Any MCP client (Claude Code, Codex, OpenCode, ...) can ask: which
harness+model is measured best for what, what does a task cost, is the
battery healthy. Read-only, stdlib-only, no network, no spend.

Speaks JSON-RPC 2.0 over stdio (line-delimited), protocol 2024-11-05.

Usage:
  python fleet/registry_mcp.py            # serve on stdio
  python fleet/registry_mcp.py selftest   # hermetic protocol test

Tools: registry_rows | matrix_report | cost_lookup | battery_selftest
"""
import contextlib
import io
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))

SERVER_NAME = "starlight-registry"
VERSION = "0.1.0"
PROTOCOL = "2024-11-05"


def _registry_path() -> Path | None:
    env = os.environ.get("STARLIGHT_REGISTRY")
    cands = [Path(env)] if env else []
    cands.append(REPO.parent / "harness-registry" / "registry.json")
    for p in cands:
        if p.exists():
            return p
    return None


def tool_registry_rows(args: dict) -> str:
    path = _registry_path()
    if not path:
        return ("registry not found (set STARLIGHT_REGISTRY or clone "
                "frankxai/harness-registry beside this repo)")
    doc = json.loads(path.read_text(encoding="utf-8"))
    q = (args.get("query") or "").lower()
    out = []
    for row in doc.get("cli_index", []):
        blob = json.dumps(row, ensure_ascii=False).lower()
        if q and q not in blob:
            continue
        out.append(f"{row.get('cli')}: {row.get('measured_diff')}\n"
                   f"  decision: {row.get('decision')}")
    return "\n".join(out) if out else f"no rows match {q!r}"


def tool_matrix_report(_args: dict) -> str:
    import harness_matrix
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        harness_matrix.report()
    return buf.getvalue().strip() or "no matrix rows in the ledger"


def tool_cost_lookup(args: dict) -> str:
    import harness_eval as he
    model_q = (args.get("model") or "").lower()
    rows = [r for r in he.load_results() if r.get("model")]
    if model_q:
        rows = [r for r in rows if model_q in r["model"].lower()]
    if not rows:
        return "no graded rows match"
    agg = {}
    for r in rows:
        a = agg.setdefault(r["model"], {"n": 0, "ok": 0, "cost": 0.0,
                                        "cost_n": 0})
        a["n"] += 1
        a["ok"] += int(bool(r.get("ok")))
        if r.get("cost_usd") is not None:
            a["cost"] += float(r["cost_usd"])
            a["cost_n"] += 1
    lines = []
    for m, a in sorted(agg.items()):
        cost = (f"${a['cost'] / a['cost_n']:.6f}/task"
                if a["cost_n"] else "cost unrecorded")
        lines.append(f"{m}: n={a['n']} pass={a['ok'] / a['n']:.0%} {cost}")
    return "\n".join(lines)


def tool_battery_selftest(_args: dict) -> str:
    import harness_eval as he
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            he.cmd_selftest(None)
        return buf.getvalue().strip() or "selftest ran"
    except SystemExit as e:
        return f"battery selftest FAILED (exit {e.code}): " + buf.getvalue()


TOOLS = {
    "registry_rows": {
        "fn": tool_registry_rows,
        "description": "Search the measured harness registry (registry.json "
                       "cli_index rows: measured_diff + decision).",
        "schema": {"type": "object",
                   "properties": {"query": {"type": "string"}}},
    },
    "matrix_report": {
        "fn": tool_matrix_report,
        "description": "Markdown table of the measured harness matrix "
                       "(pass rate, latency, cost class) from the ledger.",
        "schema": {"type": "object", "properties": {}},
    },
    "cost_lookup": {
        "fn": tool_cost_lookup,
        "description": "Aggregate graded rows by model: n, pass rate, "
                       "measured $/task where receipts allow.",
        "schema": {"type": "object",
                   "properties": {"model": {"type": "string"}}},
    },
    "battery_selftest": {
        "fn": tool_battery_selftest,
        "description": "Run the deterministic battery checker selftest "
                       "(hermetic, no model calls) and return its verdict.",
        "schema": {"type": "object", "properties": {}},
    },
}


def _reply(req_id, result=None, error=None) -> None:
    msg = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def serve() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            _reply(None, error={"code": -32700, "message": "parse error"})
            continue
        method = req.get("method")
        req_id = req.get("id")
        if method == "initialize":
            _reply(req_id, {
                "protocolVersion": PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": VERSION},
            })
        elif method in ("notifications/initialized", "notifications/*"):
            continue  # notification: no response
        elif method == "ping":
            _reply(req_id, {})
        elif method == "tools/list":
            _reply(req_id, {"tools": [
                {"name": n, "description": t["description"],
                 "inputSchema": t["schema"]}
                for n, t in TOOLS.items()]})
        elif method == "tools/call":
            params = req.get("params") or {}
            name = params.get("name")
            tool = TOOLS.get(name)
            if not tool:
                _reply(req_id, error={"code": -32602,
                                      "message": f"unknown tool: {name}"})
                continue
            try:
                text = tool["fn"](params.get("arguments") or {})
                _reply(req_id, {"content": [{"type": "text", "text": text}],
                                "isError": False})
            except Exception as e:  # noqa: BLE001 - protocol never crashes
                _reply(req_id, {"content": [{"type": "text",
                                             "text": f"tool error: {e}"}],
                                "isError": True})
        else:
            _reply(req_id, error={"code": -32601,
                                  "message": f"method not found: {method}"})
    return 0


def selftest() -> int:
    """Spawn the server, drive the protocol, assert the contract."""
    import subprocess
    proc = subprocess.Popen([sys.executable, "-B", str(HERE / "registry_mcp.py")],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            text=True, encoding="utf-8")
    fails = []

    def rpc(obj):
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()
        return json.loads(proc.stdout.readline())

    try:
        init = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": PROTOCOL,
                               "capabilities": {},
                               "clientInfo": {"name": "selftest",
                                              "version": "0"}}})
        info = (init.get("result") or {}).get("serverInfo") or {}
        if info.get("name") != SERVER_NAME:
            fails.append("initialize: serverInfo name")
        proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()
        tl = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = [t["name"] for t in tl.get("result", {}).get("tools", [])]
        if set(names) != set(TOOLS):
            fails.append(f"tools/list mismatch: {names}")
        call = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                    "params": {"name": "cost_lookup", "arguments": {}}})
        content = (call.get("result") or {}).get("content") or [{}]
        if not content[0].get("text"):
            fails.append("cost_lookup returned no text")
        unknown = rpc({"jsonrpc": "2.0", "id": 4, "method": "nope"})
        if (unknown.get("error") or {}).get("code") != -32601:
            fails.append("unknown method must be -32601")
        us = rpc({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                  "params": {"name": "nope", "arguments": {}}})
        if (us.get("error") or {}).get("code") != -32602:
            fails.append("unknown tool must be -32602")
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
    if fails:
        print("MCP SELFTEST FAIL: " + "; ".join(fails))
        return 1
    print(f"mcp selftest OK: initialize, {len(TOOLS)} tools, cost_lookup, "
          "protocol errors (-32601/-32602)")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["selftest"]:
        raise SystemExit(selftest())
    raise SystemExit(serve())
