"""Подставная serena для tests/mcp-hub-detach.test.sh. Тест копирует её как <tmp>/bin/serena:
mcp-hub.sh узнаёт python serena по имени скрипта. Слушает --port и отвечает на POST /mcp; порт
занят — не выходит, как настоящая сирота.

  FAKE_SERENA_IGNORE_TERM=1   SIGTERM игнорирует, как настоящая (на TERM не выходила 10+ с);
  FAKE_SERENA_NO_LSP=1        без «LSP»-внука в своей сессии (по умолчанию он есть, тоже глух к TERM);
  FAKE_SERENA_GROUP_ORPHAN=1  ещё внук в ЕЁ группе, но осиротевший (ppid 1): найти его можно только
                              групповым kill, обход дерева его уже не видит;
  FAKE_SERENA_DIE_AFTER=<с>   упасть через столько секунд после старта;
  FAKE_SERENA_CLOSE_AFTER=<с> закрыть порт через столько секунд и жить дальше;
  FAKE_MARK                   метка (каталог теста) в командной строке внуков — по ней тест их находит.
"""
import http.server
import os
import signal
import subprocess
import sys
import threading
import time

DEAF = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(3600)"
QUIET = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
MARK = os.environ.get("FAKE_MARK", "")

args = sys.argv[1:]
port = int(args[args.index("--port") + 1])
if os.environ.get("FAKE_SERENA_IGNORE_TERM") == "1":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
if os.environ.get("FAKE_SERENA_NO_LSP") != "1":
    subprocess.Popen([sys.executable, "-c", DEAF, "fake-lsp", MARK], start_new_session=True, **QUIET)
if os.environ.get("FAKE_SERENA_GROUP_ORPHAN") == "1":
    # Промежуточный процесс порождает внука и сразу выходит: внук остаётся в группе serena с ppid 1.
    spawn = ("import subprocess, sys; subprocess.Popen([sys.executable, '-c', sys.argv[1], 'fake-group-orphan',"
             " sys.argv[2]], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)")
    subprocess.Popen([sys.executable, "-c", spawn, DEAF, MARK], **QUIET)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = b'{"jsonrpc": "2.0", "id": 1, "result": {}}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


try:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
except OSError as exc:
    print(f"fake serena: :{port} не открыть ({exc}) — живу дальше, как настоящая сирота", flush=True)
    while True:
        time.sleep(3600)
die_after = float(os.environ.get("FAKE_SERENA_DIE_AFTER") or 0)
if die_after:
    threading.Timer(die_after, lambda: (print("fake serena: падаю", flush=True), os._exit(3))).start()
close_after = float(os.environ.get("FAKE_SERENA_CLOSE_AFTER") or 0)
if close_after:
    threading.Timer(close_after, server.shutdown).start()
print(f"fake serena слушает :{port}", flush=True)
server.serve_forever()
server.server_close()
print("fake serena: порт закрыт, живу дальше", flush=True)
while True:
    time.sleep(3600)
