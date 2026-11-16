"""TimeTree MCP（Drive正本）をstdio JSON-RPCで起動し、読み取りツールを検証する。"""

import json
import os
import subprocess
import sys
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]
MCP_SCRIPT = os.environ.get("TIMETREE_MCP_SCRIPT") or (
	r"D:\Program\agent-mcp\timetree\TimeTree-Mcp.py"
)
env = dict(os.environ)
# トークンはMCP自身の解決（環境変数→Relayのwork/relay-token.txt）に任せる。
env.pop("TIMETREE_RELAY_API_TOKEN", None)

proc = subprocess.Popen(
	[sys.executable, MCP_SCRIPT],
	stdin=subprocess.PIPE,
	stdout=subprocess.PIPE,
	stderr=subprocess.PIPE,
	env=env,
	text=True,
	encoding="utf-8",
)


def send(message: dict) -> None:
	proc.stdin.write(json.dumps(message) + "\n")
	proc.stdin.flush()


def recv() -> dict:
	line = proc.stdout.readline()
	if not line:
		proc.terminate()
		err = proc.stderr.read() if proc.stderr else ""
		raise SystemExit(f"MCPが応答を返しませんでした stderr: {err[:2000]}")
	return json.loads(line)


try:
	send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "1.0"}}})
	init = recv()
	print("server:", init["result"]["serverInfo"]["name"])
	send({"jsonrpc": "2.0", "method": "notifications/initialized"})
	send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	tools = recv()
	print("tools:", [tool["name"] for tool in tools["result"]["tools"]])
	send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "timetree_status", "arguments": {}}})
	status = recv()
	print("status:", json.dumps(status["result"], ensure_ascii=False)[:300])
	send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "timetree_list_calendars", "arguments": {}}})
	calendars = recv()
	text = calendars["result"]["content"][0]["text"]
	items = json.loads(text)["data"]["items"]
	print("calendars:", [(item["id"], item["name"]) for item in items])
finally:
	proc.terminate()
	proc.wait(timeout=10)
