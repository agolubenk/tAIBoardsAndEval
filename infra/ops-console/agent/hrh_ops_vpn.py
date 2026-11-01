"""
HR Helper Ops — WireGuard в отчёте агента (агент ≥ 1.6). Только stdlib python3 (>= 3.8).

Агент работает без root, поэтому WireGuard и conntrack снимает корневой сборщик hrh-ops-vpnd.py (юнит
hrh-ops-vpn.service), а здесь читается его файл OPS_VPN_FILE (/run/hrh-ops-vpn/vpn.json). Нет файла — сборщик не
установлен, и `vpn` в отчёт не попадает.

В каждом отчёте — пиры: имя (OPS_VPN_PEERS), рукопожатие, онлайн, трафик, скорость, RTT и потери.
С нового снимка сборщика, не чаще раза в DEST_EVERY (5 мин), — куда ходили пиры: top за час и за сутки. Окна —
корзины по 5 мин и по часу, в корзине не больше KEYS_5M / KEYS_1H направлений, остальное — суммой «прочее» (ключ OTHER).
Корзины переживают перезапуск агента (vpn-flows.json.gz в StateDirectory, файл 0600). Снимки, пришедшие, пока агент не
работал, не учитываются: сборщик держит только последний интервал.

Имена адресов — обратным DNS (PTR), подтверждённым прямым запросом (FCrDNS), в фоновом потоке, кэш на сутки: VPS видит
адреса, а не имена (DNS клиентов идёт на 1.1.1.1 через туннель как обычный трафик). OPS_VPN_PTR=0 — не спрашивать.
"""
import gzip
import io
import ipaddress
import json
import os
import queue
import socket
import threading
import time
import zlib

from hrh_ops_collect import log

ONLINE_SEC = 180  # WireGuard переподтверждает ключ раз в 2 мин, пока есть трафик или keepalive
FILE_MAX = 4 * 1024 * 1024
TOP = 50
KEYS_5M = 400
KEYS_1H = 1500
OTHER = "*"
SAVE_EVERY = 900  # состояние — до ~4 МБ JSON (~10× меньше в gzip); потеря при сбое — до 15 минут учёта
DEST_EVERY = 300  # направления в отчёт: окна из 5-минутных корзин, чаще слать — только трафик и записи в базу консоли
PTR_TTL = 86400
PTR_MAX = 4000


def parse_names(raw):
    """OPS_VPN_PEERS «10.77.0.2=Mac,10.77.0.3=телефон» → {ip: имя}."""
    out = {}
    for part in (raw or "").split(","):
        ip, sep, name = part.partition("=")
        if sep and ip.strip() and name.strip():
            out[ip.strip()] = name.strip()[:48]
    return out


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


class Buckets:
    """Окно из корзин по width секунд: {начало: {ключ: [байт от пира, байт к пиру, новых соединений]}}."""

    def __init__(self, width, keep, keys_max):
        self.width, self.keep, self.keys_max = width, keep, keys_max
        self.data = {}

    def add(self, ts, rows):
        start = int(ts // self.width) * self.width
        bucket = self.data.setdefault(start, {})
        for key, up, down, conns in rows:
            if key not in bucket and len(bucket) >= self.keys_max:
                key = OTHER
            v = bucket.setdefault(key, [0, 0, 0])
            v[0] += up
            v[1] += down
            v[2] += conns
        for old in [s for s in self.data if s <= ts - self.width * self.keep]:
            del self.data[old]

    def window(self, now, span):
        """Сумма корзин, начавшихся за последние span секунд."""
        total = {}
        for start, bucket in self.data.items():
            if start > now - span:
                for key, v in bucket.items():
                    t = total.setdefault(key, [0, 0, 0])
                    for i in range(3):
                        t[i] += v[i]
        return total

    def dump(self):
        return {str(k): v for k, v in self.data.items()}

    def load(self, raw):
        try:
            self.data = {int(k): {str(kk): [int(x) for x in vv[:3]] for kk, vv in v.items()} for k, v in raw.items()}
        except (AttributeError, TypeError, ValueError):
            self.data = {}


def is_public(ip):
    try:
        return ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


class Ptr:
    """Обратный DNS в одном фоновом потоке: отчёт не ждёт резолвер (таймаут системный, до 10 с на адрес).

    Имя показывается, только если прямой запрос по нему возвращает тот же адрес (FCrDNS): PTR своего адреса владелец
    сети пишет какой угодно — «accounts.google.com» на чужом сервере в таблице владельца вводил бы в заблуждение.
    """

    def __init__(self, enabled=True, resolver=socket.gethostbyaddr, clock=time.time, forward=socket.getaddrinfo):
        self.enabled, self.resolver, self.clock, self.forward = enabled, resolver, clock, forward
        self.cache = {}  # ip → (имя | "", когда)
        self.queued = set()
        self.q = queue.Queue(maxsize=256)
        self.thread = None

    def name(self, ip):
        hit = self.cache.get(ip)
        if hit and self.clock() - hit[1] < PTR_TTL:
            return hit[0] or None
        if self.enabled and ip not in self.queued and is_public(ip):
            try:
                self.q.put_nowait(ip)
                self.queued.add(ip)
            except queue.Full:
                pass
            if self.thread is None:
                self.thread = threading.Thread(target=self._loop, name="vpn-ptr", daemon=True)
                self.thread.start()
        return hit[0] if hit and hit[0] else None

    def resolve_one(self, ip):
        try:
            host = self.resolver(ip)[0].rstrip(".")[:120]
        except (OSError, UnicodeError, IndexError):
            host = ""
        if host and not self.confirmed(host, ip):
            host = ""
        if len(self.cache) >= PTR_MAX:
            for old in sorted(self.cache, key=lambda k: self.cache[k][1])[: PTR_MAX // 4]:
                del self.cache[old]
        self.cache[ip] = (host, self.clock())
        self.queued.discard(ip)

    def confirmed(self, host, ip):
        try:
            want = ipaddress.ip_address(ip)
            return any(ipaddress.ip_address(ai[4][0].split("%")[0]) == want for ai in self.forward(host, None))
        except (OSError, UnicodeError, ValueError, IndexError, TypeError):
            return False

    def _loop(self):
        while True:
            self.resolve_one(self.q.get())


class VpnFeed:
    def __init__(self, path, names, state_dir=None, ptr=None, clock=time.time):
        self.path, self.names, self.clock = path, names, clock
        self.ptr = ptr if ptr is not None else Ptr()
        self.state = os.path.join(state_dir, "vpn-flows.json.gz") if state_dir else None
        self.m5 = Buckets(300, 13, KEYS_5M)
        self.h1 = Buckets(3600, 25, KEYS_1H)
        self.seen = None  # (started, seq) последнего учтённого снимка сборщика
        self.saved_at = 0.0
        self.dest_at = 0.0
        self.meta = {}
        self.logged = None
        self._load()

    def _load(self):
        if not self.state:
            return
        try:
            with gzip.open(self.state, "rt", encoding="utf-8") as f:
                d = json.load(f)
            self.m5.load(d.get("m5") or {})
            self.h1.load(d.get("h1") or {})
            seen = d.get("seen")
            self.seen = tuple(seen) if isinstance(seen, list) and len(seen) == 2 else None
        except (OSError, EOFError, zlib.error, ValueError, TypeError, AttributeError):
            pass

    def _save(self, now):
        if not self.state or now - self.saved_at < SAVE_EVERY:
            return
        self.saved_at = now
        tmp = self.state + ".tmp"
        try:
            # 0600: тут сутки направлений владельца, а каталог состояния читают и другие учётки хоста.
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=5, mtime=0) as gz:
                with io.TextIOWrapper(gz, encoding="utf-8") as f:
                    json.dump({"seen": list(self.seen) if self.seen else None, "m5": self.m5.dump(), "h1": self.h1.dump()}, f, separators=(",", ":"))
            os.replace(tmp, self.state)
        except OSError as e:
            log("учёт направлений VPN не сохранён (%s)" % e)

    def read(self):
        """Снимок сборщика, None — сборщика нет, или {"error": код}."""
        try:
            with open(self.path, "rb") as f:
                raw = f.read(FILE_MAX + 1)
        except FileNotFoundError:
            return None
        except PermissionError:
            return {"error": "no_access"}
        except OSError:
            return {"error": "read_failed"}
        try:
            snap = json.loads(raw.decode("utf-8")) if len(raw) <= FILE_MAX else None
        except ValueError:
            snap = None
        if not isinstance(snap, dict) or snap.get("v") != 1 or not isinstance(snap.get("peers"), list):
            return {"error": "bad_file"}
        return snap

    def _ingest(self, snap):
        """Новый снимок с приростом направлений → в корзины. True — снимок новый (его top уйдёт в отчёт)."""
        mark = (snap.get("started"), snap.get("seq"))
        if mark == self.seen:
            return False
        self.seen = mark
        flows = snap.get("flows") if isinstance(snap.get("flows"), dict) else {}
        self.meta = {
            "flowsSource": str(flows.get("source") or "none")[:16],
            "flowsAcct": flows.get("acct") is True,
            "flowsTruncated": flows.get("truncated") is True,
        }
        if not flows.get("warm"):
            return True
        rows = []
        for r in flows.get("top") or []:
            if isinstance(r, list) and len(r) == 7:
                peer, proto, dst, port, up, down, conns = r
                rows.append(("%s\t%s\t%s\t%s" % (peer, proto, dst, port), int(up or 0), int(down or 0), int(conns or 0)))
        other = flows.get("other")
        if isinstance(other, list) and len(other) == 3 and any(other):
            rows.append((OTHER, int(other[0]), int(other[1]), int(other[2])))
        at = float(snap.get("at") or self.clock())
        self.m5.add(at, rows)
        self.h1.add(at, rows)
        return True

    def _top(self, buckets, now, span):
        total = buckets.window(now, span)
        sums = [sum(v[i] for v in total.values()) for i in range(3)]
        keys = [k for k in total if k != OTHER]
        keys.sort(key=lambda k: (total[k][0] + total[k][1], total[k][2]), reverse=True)
        rows = []
        for k in keys[:TOP]:
            peer, proto, dst, port = k.split("\t")
            up, down, conns = total[k]
            row = {"peer": self.names.get(peer, peer), "proto": proto, "dst": dst, "port": int(port), "up": up, "down": down, "conns": conns}
            host = self.ptr.name(dst)
            if host:
                row["host"] = host
            rows.append(row)
        return {"rows": rows, "keys": len(keys), "total": sums}

    def attach(self, payload):
        snap = self.read()
        if snap is None:
            return
        if "error" in snap:
            if self.logged != snap["error"]:
                self.logged = snap["error"]
                log("VPN: файл сборщика %s не прочитан (%s)" % (self.path, snap["error"]))
            payload["vpn"] = {"state": "error", "error": snap["error"]}
            return
        self.logged = None
        now = self.clock()
        at = _num(snap.get("at")) or 0
        interval = int(_num(snap.get("interval")) or 30)
        fresh = now - at <= interval * 3 + 15
        out = {
            "state": ("ok" if snap.get("wg") == "ok" else "no_wg") if fresh else "stale",
            "at": int(at),
            "interval": interval,
            "peers": [self._peer(p, now, fresh) for p in snap["peers"][:32] if isinstance(p, dict)],
        }
        new = self._ingest(snap) if fresh else False
        out.update(self.meta)
        # Окна накопительные: недоставленный отчёт ничего не теряет — следующий новый снимок принесёт те же суммы и больше.
        if new and now - self.dest_at >= DEST_EVERY:
            self.dest_at = now
            out["destinations"] = {"at": int(at), "h1": self._top(self.m5, now, 3600), "h24": self._top(self.h1, now, 86400)}
        self._save(now)
        payload["vpn"] = out

    def _peer(self, p, now, fresh):
        ip = str(p.get("ip") or "")[:64]
        hs = _num(p.get("handshakeAt")) or 0
        age = int(now - hs) if hs > 0 else None
        peer = {
            "name": self.names.get(ip, ip),
            "iface": str(p.get("iface") or "")[:32],
            "ip": ip,
            "online": age is not None and age < ONLINE_SEC,
            "handshakeAgeSec": max(0, age) if age is not None else None,
            "rx": int(_num(p.get("rx")) or 0),
            "tx": int(_num(p.get("tx")) or 0),
        }
        for k in ("rxBps", "txBps", "rttMs", "lossPct"):
            v = _num(p.get(k)) if fresh else None
            if v is not None:
                peer[k] = v
        ping_at = _num(p.get("pingAt"))
        if fresh and ping_at:
            peer["pingAgeSec"] = max(0, int(now - ping_at))
        endpoint = str(p.get("endpoint") or "")[:80]
        if endpoint:
            peer["endpoint"] = endpoint
        return peer
