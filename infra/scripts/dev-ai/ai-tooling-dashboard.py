#!/usr/bin/env python3
"""Read-only local status page for the developer AI-tooling pipeline."""
import json
import os
import shutil
import socket
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
HEADROOM_BIN = os.environ.get("HEADROOM_BIN", "headroom")
HEADROOM_PORT = int(os.environ.get("HEADROOM_PORT", "8787"))

def http_ok(url):
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False

def tcp_ok(host, port):
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False

def status():
    glm_key = bool(os.environ.get("GLM_API_KEY")) or (ROOT / ".claude/rag/.glm-key").is_file()
    return {
        "headroom_cli": bool(shutil.which(HEADROOM_BIN)),
        # A listening Docker forwarder alone does not prove HEADROOM owns or is healthy on it.
        "headroom_port": tcp_ok("127.0.0.1", HEADROOM_PORT),
        "ollama": http_ok(OLLAMA_URL + "/api/tags"),
        "glm": glm_key and os.environ.get("DAMS_GLM", "").lower() not in {"off", "0", "false"},
        "claude_code": (ROOT / ".claude/settings.json").is_file() and bool(shutil.which("claude")),
        "continue": (ROOT / ".continue/config.yaml").is_file(),
        "workflow": "HEADROOM → GLM task brief → HEADROOM handoff",
    }

HTML = """<!doctype html><meta charset=utf-8><title>AI tooling pipeline</title>
<style>body{font:16px system-ui;margin:3rem;max-width:820px;color:#16202a}h1{margin-bottom:.2rem}.muted{color:#5d6872}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-top:24px}.card{border:1px solid #d7dce1;border-radius:10px;padding:16px}.ok{color:#137333}.bad{color:#b3261e}</style>
<h1>AI tooling pipeline</h1><p class=muted id=workflow>Loading…</p><div class=grid id=cards></div><p class=muted>Refreshes every 5 seconds. Read-only; localhost only.</p>
<script>const labels={headroom_cli:'HEADROOM CLI',headroom_port:'Port 8787 listener (not ownership)',ollama:'Ollama (Continue local models)',glm:'GLM task brief',claude_code:'Claude Code hooks',continue:'Continue project config'};async function load(){let s=await (await fetch('/api/status')).json();document.querySelector('#workflow').textContent=s.workflow;document.querySelector('#cards').innerHTML=Object.entries(labels).map(([k,v])=>`<section class=card><strong>${v}</strong><p class=${s[k]?'ok':'bad'}>${s[k]?'Ready':'Unavailable'}</p></section>`).join('')}load();setInterval(load,5000)</script>"""

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/status":
            body = json.dumps(status()).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(body)
        elif self.path in {"/", "/index.html"}:
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers(); self.wfile.write(HTML.encode())
        else:
            self.send_error(404)
    def log_message(self, *_):
        pass

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1] if len(sys.argv) > 1 else "8788")), Handler).serve_forever()
