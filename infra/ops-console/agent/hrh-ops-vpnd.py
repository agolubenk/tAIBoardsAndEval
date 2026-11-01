#!/usr/bin/env python3
"""
HR Helper Ops — сборщик WireGuard для агента (root, юнит hrh-ops-vpn.service). Только stdlib python3 (>= 3.8).

Агент работает без root и не видит ни `wg show` (netlink, CAP_NET_ADMIN), ни таблицу conntrack. Этот процесс раз в
OPS_VPN_INTERVAL (30 с) снимает их и пишет итог в OPS_VPN_FILE (/run/hrh-ops-vpn/vpn.json, 0640 root:hrh-ops), агент
читает файл. Входа у процесса нет: ни сокета, ни аргументов, ни чтения чужих файлов — только пишет свой.

Что в файле:
  peers  по пиру: allowed-ips, последнее рукопожатие, endpoint, счётчики rx/tx и скорость между двумя снимками этого
         процесса (по его меткам времени: агент на своём таймере считал бы то 0, то вдвое). RTT и потери — 3 ping раз
         в 5 мин и только у пира, от которого с прошлого пинга пришли данные: спящий телефон не будим, платный
         трафик не тратим.
  flows  куда ходили пиры: прирост байт и новые соединения по (пир, протокол, адрес, порт) за интервал, top 300.
         Источник — /proc/net/nf_conntrack, иначе `conntrack -L` (пакет conntrack). Байты — только при
         net.netfilter.nf_conntrack_acct=1, без него — число соединений. Первый снимок после старта — точка отсчёта.

`wg show … private-key` и `wg show … dump` не вызываются никогда: в их выводе приватный ключ интерфейса.
Запуск: python3 hrh-ops-vpnd.py [--once]   (--once — два снимка с паузой 5 с, итог в stdout)
"""
import ipaddress
import json
import os
import re
import subprocess
import sys
import threading
import time

FORMAT = 1
PROC_CT = "/proc/net/nf_conntrack"
ACCT = "/proc/sys/net/netfilter/nf_conntrack_acct"
PROTOS = {"tcp", "udp", "icmp", "icmpv6", "sctp", "udplite", "dccp", "gre"}
LINES_MAX = 300_000  # строк всей таблицы conntrack за снимок (не только пиров) — потолок CPU под флудом
CT_TIMEOUT = 15
FLOWS_MAX = 20000  # соединений пиров между снимками; больше — остальные не считаем (truncated)
TOP = 300  # направлений в файле за интервал; остальное — суммой в other
PING_EVERY = 300
# Пир активен, если с прошлого пинга от него пришло больше: keepalive — 32 байта раз в 25 с, ответы пинга — ~250 байт.
PING_MIN_RX = 4096
RTT = re.compile(r"= [\d.]+/([\d.]+)/")
LOSS = re.compile(r"([\d.]+)% packet loss")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def run(argv, timeout):
    """stdout команды или None (нет бинарника, ненулевой код, таймаут). Без shell: аргументы — список."""
    try:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout.decode("utf-8", "replace") if p.returncode == 0 else None


def wg_table(what, runner=run):
    """`wg show all <what>` → {(iface, pubkey): [поля]}. None — wg нет или он не ответил."""
    out = runner(["wg", "show", "all", what], 10)
    if out is None:
        return None
    rows = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            rows[(parts[0], parts[1])] = parts[2:]
    return rows


def _int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def read_peers(runner=run):
    """Пиры всех интерфейсов. Публичный ключ — только ключ сопоставления в памяти, в файл не пишется. None — нет wg."""
    allowed = wg_table("allowed-ips", runner)
    if allowed is None:
        return None
    hs = wg_table("latest-handshakes", runner) or {}
    tr = wg_table("transfer", runner) or {}
    ep = wg_table("endpoints", runner) or {}
    peers = []
    for key, val in sorted(allowed.items()):
        nets = []
        for n in val[0].split():
            try:
                nets.append(ipaddress.ip_network(n, strict=False))
            except ValueError:
                continue
        if not nets:
            continue
        first = nets[0]
        single = first.prefixlen == first.max_prefixlen
        rx_tx = tr.get(key, ["0", "0"])
        endpoint = (ep.get(key) or [""])[0]
        peers.append(
            {
                "key": key,
                "iface": key[0][:32],
                "ip": str(first.network_address) if single else str(first),
                "allowed": [str(n) for n in nets[:8]],
                "nets": nets,
                "handshakeAt": _int((hs.get(key) or ["0"])[0]),
                "endpoint": "" if endpoint == "(none)" else endpoint[:80],
                "rx": _int(rx_tx[0]),
                "tx": _int(rx_tx[1] if len(rx_tx) > 1 else 0),
            }
        )
    return peers


class PeerOf:
    """Адрес источника соединения → пир. /32 — множеством, остальное — по сетям с кэшем (в conntrack тысячи строк)."""

    def __init__(self, peers):
        self.exact = {}
        self.nets = []
        for p in peers:
            for n in p["nets"]:
                if n.prefixlen == n.max_prefixlen:
                    self.exact[str(n.network_address)] = p["ip"]
                else:
                    self.nets.append((n, p["ip"]))
        self.cache = {}

    def __call__(self, src):
        hit = self.exact.get(src)
        if hit is not None or not self.nets:
            return hit
        if src not in self.cache:
            if len(self.cache) > 4096:
                self.cache.clear()
            try:
                addr = ipaddress.ip_address(src)
                self.cache[src] = next((ip for n, ip in self.nets if addr.version == n.version and addr in n), None)
            except ValueError:
                self.cache[src] = None
        return self.cache[src]


def parse_flow(line, peer_of):
    """Строка conntrack → (ключ соединения, пир, байт туда, байт обратно) или None, если источник — не пир.

    Формат /proc и `conntrack -L -o extended` один: «ipv4 2 tcp 6 117 TIME_WAIT src= dst= sport= dport= [packets=
    bytes=] src= dst= …» — первая четвёрка src/dst/порты — исходное направление (от пира), вторая — ответ.
    """
    i = line.find("src=")
    if i < 0:
        return None
    j = line.find(" ", i)
    peer = peer_of(line[i + 4 : j if j > 0 else None])
    if peer is None:
        return None
    toks = line.split()
    proto = next((t for t in toks[:4] if t in PROTOS), "other")
    orig, reply = {}, {}
    for t in toks:
        k, sep, v = t.partition("=")
        if not sep:
            continue
        if k not in orig:
            orig[k] = v
        elif k not in reply:
            reply[k] = v
    port = _int(orig.get("dport"))
    key = (proto, orig.get("src", ""), orig.get("dst", ""), orig.get("sport") or orig.get("id") or "", port)
    return key, peer, _int(orig.get("bytes"), -1), _int(reply.get("bytes"), -1)


class CtLines:
    """Строки conntrack потоком, не больше LINES_MAX. Таблица хоста — весь Docker, а под флудом на порт WireGuard — до
    nf_conntrack_max строк; целиком в памяти её не держим. Вывод `conntrack -L` читается из трубы; процесс убивается
    таймаутом (тогда снимок неполный — truncated) или в close(), если дочитывать не нужно."""

    def __init__(self, f, proc=None, timeout=CT_TIMEOUT):
        self.f, self.proc, self.read = f, proc, 0
        self.truncated = self.failed = self.expired = False
        self.timer = None
        if proc is not None:
            self.timer = threading.Timer(timeout, self._expire)
            self.timer.daemon = True
            self.timer.start()

    def _expire(self):
        self.expired = True
        self.proc.kill()

    def __iter__(self):
        for line in self.f:
            if self.read >= LINES_MAX:
                self.truncated = True
                break
            self.read += 1
            yield line

    def close(self):
        self.f.close()
        if self.proc is None:
            return
        self.timer.cancel()
        if self.proc.poll() is None:
            self.proc.kill()
        code = self.proc.wait()
        self.truncated = self.truncated or self.expired
        # Ни строки и ненулевой код (нет прав, модуль не загружен) — источника нет, а не «соединений нет».
        self.failed = self.read == 0 and code != 0


def conntrack_lines(runner=None, argv=("conntrack", "-L", "-o", "extended")):
    """(источник, CtLines | None): /proc/net/nf_conntrack, иначе вывод `conntrack -L`. runner — для подмены в тестах."""
    try:
        return "proc", CtLines(open(PROC_CT, encoding="ascii", errors="replace"))
    except OSError:
        pass
    try:
        proc = subprocess.Popen(
            list(argv), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, encoding="ascii", errors="replace"
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return "none", None
    return "conntrack", CtLines(proc.stdout, proc)


class FlowTracker:
    """Прирост по соединениям между снимками. Одна и та же пятёрка после закрытия — новое соединение (счётчик меньше)."""

    def __init__(self):
        self.prev = None

    def scan(self, rows):
        cur, agg, truncated = {}, {}, False
        warm, prev = self.prev is not None, self.prev or {}
        for key, peer, up, down in rows:
            if len(cur) >= FLOWS_MAX:
                truncated = True
                break
            cur[key] = (up, down)
            if not warm:
                continue
            p = prev.get(key)
            if p is None:
                new, du, dd = 1, max(up, 0), max(down, 0)
            else:
                new = 0
                du = up - p[0] if up >= p[0] else max(up, 0)
                dd = down - p[1] if down >= p[1] else max(down, 0)
            if not (new or du > 0 or dd > 0):
                continue
            a = agg.setdefault((peer, key[0], key[2], key[4]), [0, 0, 0])
            a[0] += du
            a[1] += dd
            a[2] += new
        self.prev = cur
        return agg, truncated, warm, len(cur)


def ping(ip, runner=subprocess.run):
    """(RTT мс | None, потери %) по 3 пакетам. Адрес — из allowed-ips пира, уже разобранный ipaddress."""
    try:
        p = runner(
            ["ping", "-n", "-q", "-c", "3", "-i", "0.2", "-W", "1", ip],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            timeout=8,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = p.stdout.decode("utf-8", "replace")
    loss = LOSS.search(out)
    if not loss:
        return None
    rtt = RTT.search(out)
    return (round(float(rtt.group(1)), 1) if rtt else None), float(loss.group(1))


def read_acct():
    try:
        with open(ACCT) as f:
            return f.read().strip() == "1"
    except OSError:
        return False


class Collector:
    def __init__(self, interval, runner=run, pinger=ping, ct_source=conntrack_lines):
        self.interval = interval
        self.runner, self.pinger, self.ct_source = runner, pinger, ct_source
        self.started = time.time()
        self.seq = 0
        self.last = {}  # ключ пира → (at, rx, tx)
        self.pings = {}  # ключ пира → {at, rx, rttMs, lossPct}
        self.flows = FlowTracker()

    def _rates(self, p, now):
        prev = self.last.get(p["key"])
        self.last[p["key"]] = (now, p["rx"], p["tx"])
        if not prev or now <= prev[0] or p["rx"] < prev[1] or p["tx"] < prev[2]:
            return None, None  # первая точка или интерфейс пересоздан (счётчики сбросились)
        dt = now - prev[0]
        return round((p["rx"] - prev[1]) / dt, 1), round((p["tx"] - prev[2]) / dt, 1)

    def _ping(self, p, now):
        last = self.pings.get(p["key"])
        active = now - p["handshakeAt"] < 180 and (last is None or p["rx"] - last["rx"] > PING_MIN_RX)
        if active and (last is None or now - last["at"] >= PING_EVERY) and p["ip"].count("/") == 0:
            res = self.pinger(p["ip"])
            last = {"at": now, "rx": p["rx"], "rttMs": res[0] if res else None, "lossPct": res[1] if res else None}
            self.pings[p["key"]] = last
        return last

    def _flows(self, peers):
        source, lines = self.ct_source(self.runner)
        out = {"source": source, "acct": read_acct(), "warm": False, "truncated": False, "count": 0, "top": [], "other": [0, 0, 0]}
        if lines is None or not peers:
            return out
        peer_of = PeerOf(peers)
        try:
            rows = (r for r in (parse_flow(line, peer_of) for line in lines) if r is not None)
            agg, out["truncated"], out["warm"], out["count"] = self.flows.scan(rows)
        finally:
            if hasattr(lines, "close"):
                lines.close()
        if getattr(lines, "failed", False):
            out["source"] = "none"
        out["truncated"] = out["truncated"] or getattr(lines, "truncated", False)
        ranked = sorted(agg.items(), key=lambda kv: (kv[1][0] + kv[1][1], kv[1][2]), reverse=True)
        out["top"] = [[k[0], k[1], k[2], k[3], v[0], v[1], v[2]] for k, v in ranked[:TOP]]
        for _, v in ranked[TOP:]:
            out["other"] = [out["other"][i] + v[i] for i in range(3)]
        return out

    def scan(self, now=None):
        now = time.time() if now is None else now
        self.seq += 1
        peers = read_peers(self.runner)
        snap = {"v": FORMAT, "at": round(now, 3), "started": round(self.started, 3), "seq": self.seq, "interval": self.interval}
        snap["wg"] = "ok" if peers is not None else "no_wg"
        peers = peers or []
        out = []
        for p in peers:
            rx_bps, tx_bps = self._rates(p, now)
            pg = self._ping(p, now) or {}
            out.append(
                {
                    "iface": p["iface"],
                    "ip": p["ip"],
                    "allowed": p["allowed"],
                    "handshakeAt": p["handshakeAt"],
                    "endpoint": p["endpoint"],
                    "rx": p["rx"],
                    "tx": p["tx"],
                    "rxBps": rx_bps,
                    "txBps": tx_bps,
                    "rttMs": pg.get("rttMs"),
                    "lossPct": pg.get("lossPct"),
                    "pingAt": round(pg["at"]) if pg.get("at") else None,
                }
            )
        snap["peers"] = out
        snap["flows"] = self._flows(peers)
        return snap


def write_atomic(path, data):
    """Запись через временный файл и rename: агент никогда не читает половину. Группа файла — Group= юнита (hrh-ops)."""
    tmp = os.path.join(os.path.dirname(path) or ".", ".vpn.json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o640)
    try:
        os.fchmod(fd, 0o640)
        os.write(fd, json.dumps(data, separators=(",", ":")).encode("utf-8"))
    finally:
        os.close(fd)
    os.replace(tmp, path)


def main():
    interval = max(15, min(300, _int(os.environ.get("OPS_VPN_INTERVAL"), 30)))
    path = os.environ.get("OPS_VPN_FILE", "/run/hrh-ops-vpn/vpn.json")
    c = Collector(interval)
    if "--once" in sys.argv:
        c.scan()
        time.sleep(5)
        print(json.dumps(c.scan(), ensure_ascii=False, indent=2))
        return
    log("старт: снимок WireGuard и conntrack раз в %d с → %s" % (interval, path))
    while True:
        t0 = time.time()
        try:
            snap = c.scan(t0)
            write_atomic(path, snap)
        except Exception as e:  # noqa: BLE001 — сбой одного снимка не роняет сборщик
            log("снимок не записан: %s: %s" % (type(e).__name__, e))
        time.sleep(max(1.0, interval - (time.time() - t0)))


if __name__ == "__main__":
    main()
