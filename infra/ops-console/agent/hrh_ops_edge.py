"""
HR Helper Ops — домены хоста для агента (hrh-ops-agent.py, ≥ 1.5). Только stdlib python3 и CLI docker/openssl/ip.

Какие имена отдают nginx в контейнерах любого compose-проекта: раз в 10 минут `nginx -T` в каждом из них
(server_name + listen). Что с их сертификатами: раз в 6 часов и сразу для новых имён — TLS-рукопожатие с SNI на
локальный адрес, где этот nginx слушает. В консоль уходят имена, порты и метаданные сертификата; текст
конфигурации не покидает агента и не пишется в журнал — в нём бывают ключи и заголовки авторизации.
"""
import fnmatch
import hashlib
import ipaddress
import json
import re
import socket
import ssl
import subprocess
import threading
import time

from hrh_ops_collect import Background, log, run

DISCOVER_EVERY_SEC = 600
PROBE_EVERY_SEC = 6 * 3600
PROBE_BUDGET_SEC = 60
PROBE_MAX = 50
DOMAINS_MAX = 100
NGINX_T_CAP = 2 * 1024 * 1024
NGINX_T_TIMEOUT = 10
# Отказ проверки — код, а не текст исключения: текст мог бы пересказать чужой конфиг или сканировать порты.
VERIFY_ERRORS = {9: "not_yet_valid", 10: "expired", 18: "untrusted", 19: "untrusted", 20: "untrusted", 21: "untrusted", 62: "name_mismatch"}


def run_capped(cmd, timeout, cap=NGINX_T_CAP):
    """Как run(), но stdout не больше cap байт: чужой `nginx -T` с огромными map/geo не раздувает память агента.
    Возвращает (код, байты); 124 — таймаут, 125 — вывод больше cap, 127 — команды нет."""
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        return 127, b""
    killed = threading.Event()

    def kill():
        killed.set()
        p.kill()

    timer = threading.Timer(timeout, kill)
    timer.start()
    try:
        out = p.stdout.read(cap + 1) if p.stdout else b""
        if len(out) > cap:
            p.kill()
            p.wait()
            return 125, b""
        p.wait()
        return (124 if killed.is_set() else p.returncode), out
    finally:
        timer.cancel()
        if p.stdout:
            p.stdout.close()


# ── Разбор `nginx -T` ───────────────────────────────────────────────────────

TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|#[^\n]*|[{};]|[^\s{};"\'#]+')
FILE_HEADER = re.compile(r"^# configuration file (.+):\s*$", re.M)
HOSTNAME = re.compile(r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")


def clean_name(raw):
    """Имя для проверки или None: без `_`, масок, регулярок, localhost, IP-литералов и имён без точки."""
    n = raw.strip().strip("\"'").lower().rstrip(".")
    if not n or n.startswith("~") or "*" in n or n == "localhost" or n.endswith(".localhost"):
        return None
    try:
        ipaddress.ip_address(n)
        return None
    except ValueError:
        pass
    return n if HOSTNAME.match(n) else None


def parse_listen(args):
    """`listen` → (адрес или None — любой, порт, ssl) или None (unix-сокет, имя вместо адреса, мусор)."""
    if not args or args[0].startswith("unix:"):
        return None
    a, flags = args[0], set(args[1:])
    m = re.match(r"^\[([0-9a-fA-F:.]+)\](?::(\d+))?$", a)
    if m:
        addr, port = m.group(1), m.group(2) or "80"
    elif a.isascii() and a.isdigit():
        addr, port = None, a
    elif ":" in a and a.count(":") == 1:
        addr, port = a.split(":")
    else:
        addr, port = a, "80"
    if not (port.isascii() and port.isdigit()) or not 0 < int(port) < 65536:
        return None
    if addr in (None, "*", "0.0.0.0", "::"):
        addr = None
    else:
        try:
            addr = str(ipaddress.ip_address(addr))
        except ValueError:
            return None  # имя в listen не резолвим: адрес берётся только из конфигурации, а не из DNS
    return addr, int(port), "ssl" in flags


def _servers_in(text):
    stack, words, cur, out = [], [], None, []
    for m in TOKEN.finditer(text):
        t = m.group(0)
        if t.startswith("#"):
            continue
        if t == "{":
            name = words[0] if words else ""
            # server на верхнем уровне файла — из include внутри http; внутри stream/upstream/location — не наш.
            if name == "server" and len(words) == 1 and (not stack or stack == ["http"]):
                cur = {"names": [], "listens": []}
            stack.append(name)
            words = []
        elif t == "}":
            if stack and stack.pop() == "server" and cur is not None and (not stack or stack == ["http"]):
                out.append(cur)
                cur = None
            words = []
        elif t == ";":
            if cur is not None and stack and stack[-1] == "server" and words:
                if words[0] == "server_name":
                    cur["names"].extend(words[1:])
                elif words[0] == "listen":
                    lst = parse_listen(words[1:])
                    if lst:
                        cur["listens"].append(lst)
            words = []
        else:
            words.append(t)
    return out


def parse_nginx_dump(text):
    """[(имя, [(адрес, порт, ssl)])] по блокам server. `nginx -T` печатает включённые файлы по отдельности,
    поэтому каждый файл разбирается со своим стеком блоков. Без listen nginx слушает :80."""
    parts = FILE_HEADER.split(text)
    files = parts[2::2] if len(parts) > 1 else [text]
    found = {}
    for body in files:
        for srv in _servers_in(body):
            listens = srv["listens"] or [(None, 80, False)]
            for raw in srv["names"]:
                n = clean_name(raw)
                if n:
                    found.setdefault(n, [])
                    found[n].extend(x for x in listens if x not in found[n])
    return sorted(found.items())


# ── Куда стучаться с хоста ──────────────────────────────────────────────────


def local_addresses():
    """Адреса интерфейсов хоста (`ip -j addr`) — только на них агент делает TLS-рукопожатие."""
    addrs = {"127.0.0.1", "::1"}
    code, out, _ = run(["ip", "-j", "addr"], 5)
    if code == 0:
        try:
            for link in json.loads(out):
                for a in link.get("addr_info") or []:
                    if a.get("local"):
                        addrs.add(str(ipaddress.ip_address(a["local"])))
        except (ValueError, TypeError, AttributeError):
            pass
    return addrs


def inspect_network(name):
    """(host-сеть?, опубликованные порты, IP контейнера в bridge-сетях) — из docker, не из конфигурации nginx."""
    code, out, _ = run(["docker", "inspect", name], 10)
    if code != 0:
        return None
    try:
        it = json.loads(out)[0]
    except (ValueError, IndexError, TypeError):
        return None
    mode = ((it.get("HostConfig") or {}).get("NetworkMode") or "")
    ns = it.get("NetworkSettings") or {}
    ips = [n.get("IPAddress") for n in (ns.get("Networks") or {}).values() if n.get("IPAddress")]
    return mode == "host", ns.get("Ports") or {}, ips


def endpoint(listen, net, local):
    """(адрес, порт) на хосте, где слышно этот listen, или None. host-сеть — адрес из listen, но только локальный;
    bridge — опубликованный порт (0.0.0.0 → 127.0.0.1), без публикации — частный IP контейнера."""
    addr, port, _ = listen
    host_mode, ports, ips = net
    if host_mode:
        if addr is None:
            return "127.0.0.1", port
        return (addr, port) if addr in local else None
    for b in ports.get("%d/tcp" % port) or []:
        hip, hport = (b.get("HostIp") or ""), str(b.get("HostPort") or "")
        if not hport.isdigit():
            continue
        if hip in ("", "0.0.0.0", "::"):
            return "127.0.0.1", int(hport)
        try:
            return str(ipaddress.ip_address(hip)), int(hport)
        except ValueError:
            continue
    for ip in ips:
        try:
            if ipaddress.ip_address(ip).is_private:
                return ip, port
        except ValueError:
            continue
    return None  # macvlan/ipvlan с публичным адресом: это уже не «локальный вход», а чужой хост


# ── TLS ─────────────────────────────────────────────────────────────────────


def _issuer(pairs):
    """issuer из getpeercert(): ((('organizationName', 'Let's Encrypt'),), …) → O, иначе CN."""
    flat = dict(kv for rdn in pairs or () for kv in rdn)
    return (flat.get("organizationName") or flat.get("commonName") or "")[:120]


def openssl_details(der):
    """Срок и издатель из DER, когда проверка не прошла: истёкший сертификат — ровно тот случай, где срок нужен."""
    try:
        p = subprocess.run(["openssl", "x509", "-inform", "DER", "-noout", "-enddate", "-issuer"], input=der, capture_output=True, timeout=5)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {}
    text = p.stdout.decode("utf-8", "replace") if p.returncode == 0 else ""
    info = {}
    m = re.search(r"notAfter=(.+)", text)
    if m:
        try:
            info["validTo"] = int(ssl.cert_time_to_seconds(m.group(1).strip()))
        except ValueError:
            pass
    m = re.search(r"issuer=.*?\bO\s*=\s*([^,/\n]+)", text) or re.search(r"issuer=.*?\bCN\s*=\s*([^,/\n]+)", text)
    if m:
        info["issuer"] = m.group(1).strip()[:120]
    return info


def probe(name, host, port, deadline):
    """Рукопожатие с SNI: ({validTo, issuer}, код ошибки или None). Таймаут каждого сокета — не дольше остатка бюджета."""
    left = deadline - time.monotonic()
    if left < 0.5:
        return None
    timeout = min(5.0, left)
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with ssl.create_default_context().wrap_socket(sock, server_hostname=name) as s:
                cert = s.getpeercert() or {}
        info = {"issuer": _issuer(cert.get("issuer"))}
        if cert.get("notAfter"):
            info["validTo"] = int(ssl.cert_time_to_seconds(str(cert["notAfter"])))
        return info, None
    except ssl.SSLCertVerificationError as e:
        err = VERIFY_ERRORS.get(getattr(e, "verify_code", 0), "verify_failed")
    except ssl.SSLError:
        return {}, "tls_handshake"
    except (OSError, ValueError):
        return {}, "connect"
    left = deadline - time.monotonic()
    if left < 0.5:
        return {}, err
    # Второе рукопожатие — только прочитать срок и издателя уже отвергнутого сертификата; данных по нему не шлём,
    # вердикт остаётся ошибкой проверки из первого.
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with socket.create_connection((host, port), timeout=min(5.0, left)) as sock:
            with ctx.wrap_socket(sock, server_hostname=name) as s:
                der = s.getpeercert(binary_form=True)
    except (OSError, ssl.SSLError):
        return {}, err
    return (openssl_details(der) if der else {}), err


# ── Сборка ──────────────────────────────────────────────────────────────────


def is_nginx(c, patterns):
    """Чей `nginx -T` читать: OPS_NGINX_CONTAINERS (маски имён; «-» — никого), иначе сервис compose nginx или образ nginx.
    Состояние не важно: читается только запущенный, но остановленный на минуту nginx не теряет свои имена."""
    if patterns:
        return any(fnmatch.fnmatch(c.get("name", ""), p) for p in patterns if p != "-")
    repo = (c.get("image") or "").split("@")[0].rsplit(":", 1)[0].rsplit("/", 1)[-1]
    return c.get("composeService") == "nginx" or repo in ("nginx", "nginx-unprivileged")


class DomainScanner:
    """Состояние между прогонами: последний удачный разбор каждого nginx и последние проверки сертификатов.
    scan() крутится в Background раз в DISCOVER_EVERY_SEC; список контейнеров ему подкладывает каждый отчёт."""

    def __init__(self, patterns, main_project=""):
        self.patterns = patterns
        # nginx основного проекта — первый источник имени и первый под лимитом DOMAINS_MAX: соседний стек не
        # перебивает сертификат продукта своим и не вытесняет его имена из отчёта.
        self.main_project = main_project
        self.projects = {}
        self.lock = threading.Lock()
        self.containers = None  # None — docker ещё ни разу не ответил: «nginx нет» и «не знаем» — разные вещи
        self.present = set()  # nginx-контейнеры в любом состоянии: имена удаляются, только когда контейнера нет вовсе
        self.parsed = {}  # контейнер → (имена с endpoint'ами, когда разобран)
        self.probes = {}  # (имя, адрес, порт) → (info, ошибка, когда)
        self.failed = []
        self.no_timeout = set()  # образы без timeout: сразу nginx -T, а не две попытки каждые 10 минут

    @property
    def ready(self):
        return self.containers is not None

    def set_containers(self, containers):
        found = [c for c in containers if is_nginx(c, self.patterns)]
        with self.lock:
            self.present = {c.get("name") for c in found}
            self.projects = {c.get("name"): c.get("composeProject", "") for c in found}
            self.containers = [c for c in found if c.get("state") == "running"]

    def _is_main(self, source):
        return not self.main_project or self.projects.get(source) == self.main_project

    def _discover(self, local):
        with self.lock:
            targets, present = list(self.containers or []), set(self.present)
        alive, failed = set(), []
        for c in targets:
            name = c["name"]
            alive.add(name)
            # timeout внутри контейнера: таймаут docker exec убил бы только клиент, а nginx -T остался бы висеть.
            code = None
            if name not in self.no_timeout:
                code, out = run_capped(["docker", "exec", name, "timeout", str(NGINX_T_TIMEOUT), "nginx", "-T"], NGINX_T_TIMEOUT + 5)
            if code not in (0, 124, 125):  # нет timeout в образе (126/127) или старый busybox не понял синтаксис (1)
                fallback = code is not None
                code, out = run_capped(["docker", "exec", name, "nginx", "-T"], NGINX_T_TIMEOUT)
                if fallback and code == 0:
                    self.no_timeout.add(name)
            net = inspect_network(name) if code == 0 else None
            if code != 0 or net is None:
                failed.append(name[:190])
                continue  # остаётся прошлый удачный разбор, помеченный stale
            try:
                entries = []
                for dom, listens in parse_nginx_dump(out.decode("utf-8", "replace")):
                    points = [(endpoint(lst, net, local), lst[2], lst[1]) for lst in listens]
                    entries.append((dom, points))
            except Exception:  # непредвиденная конфигурация одного nginx не останавливает разбор остальных
                failed.append(name[:190])
                continue
            self.parsed[name] = (entries, time.time())
        # Перезапускается или остановлен — прошлый разбор остаётся (stale); удалён — его имена уходят.
        for gone in set(self.parsed) - alive - present:
            del self.parsed[gone]
        self.failed = sorted(failed)[:20]

    def scan(self):
        """{rows, total, failed} или None, пока docker не дал список контейнеров."""
        if not self.ready:
            return None
        local = local_addresses()
        self._discover(local)
        now = time.time()
        rows = {}
        with self.lock:
            main = {source for source in self.parsed if self._is_main(source)}
        for source, (entries, at) in sorted(self.parsed.items(), key=lambda kv: (kv[0] not in main, kv[0])):
            stale = now - at > DISCOVER_EVERY_SEC * 2
            for dom, points in entries:
                # Достижимый с хоста TLS-вход раньше недостижимого: listen 10.0.0.5:443 ssl + listen 443 ssl.
                tls_points = sorted(((ep, port) for ep, is_tls, port in points if is_tls), key=lambda p: p[0] is None)
                ep, port = (tls_points or [(None, None)])[0]
                if not tls_points:
                    port = points[0][2] if points else None
                row = rows.get(dom)
                if row and (row["tls"] or not tls_points):
                    continue  # одно имя — одна строка; TLS-вход важнее открытого
                rows[dom] = {"name": dom[:253], "source": source[:190], "tls": bool(tls_points), "stale": stale, "_ep": ep, "_main": source in main}
                if port:
                    rows[dom]["port"] = port
        ordered = sorted(rows.values(), key=lambda r: (not r["_main"], r["name"]))[:DOMAINS_MAX]
        self._probe(ordered, now)
        out = []
        for r in ordered:
            ep = r.pop("_ep")
            r.pop("_main")
            hit = self.probes.get((r["name"],) + tuple(ep)) if ep else None
            if r["tls"] and ep is None:
                r["error"] = "unreachable"
            elif hit:
                info, err, checked = hit
                r.update({k: v for k, v in info.items() if v not in (None, "")})
                if err:
                    r["error"] = err
                r["checkedAt"] = int(checked)
            out.append(r)
        return {"rows": out, "total": len(rows), "failed": list(self.failed)}

    def _probe(self, rows, now):
        deadline = time.monotonic() + PROBE_BUDGET_SEC
        due = []
        for r in rows:
            if not r["tls"] or not r["_ep"]:
                continue
            key = (r["name"],) + tuple(r["_ep"])
            prev = self.probes.get(key)
            if not prev or now - prev[2] >= PROBE_EVERY_SEC:
                due.append((prev[2] if prev else 0, key))
        # Сначала новые и самые давние: за бюджет 60 с проверяется не больше PROBE_MAX имён, остальные — в следующий раз.
        for _, key in sorted(due)[:PROBE_MAX]:
            res = probe(key[0], key[1], key[2], deadline)
            if res is None:
                break
            self.probes[key] = (res[0], res[1], time.time())
        keep = {(r["name"],) + tuple(r["_ep"]) for r in rows if r.get("_ep")}
        for k in set(self.probes) - keep:
            del self.probes[k]


class DomainFeed:
    """Когда список доменов идёт в отчёт: при изменении и раз в час (консоль, поднятая с пустой базой, восстановит
    его сама). Отметка «отправлено» — только после доставки отчёта: недоставленный список уйдёт следующим."""

    RESEND_SEC = 3600

    def __init__(self, patterns, main_project=""):
        self.scanner = DomainScanner(patterns, main_project)
        self.bg = Background(self.scanner.scan, min_interval=DISCOVER_EVERY_SEC)
        self.sent_fp, self.sent_at, self.pending = None, 0.0, None
        self.logged_error = None

    def attach(self, payload, containers, budget=0):
        if containers is not None:
            self.scanner.set_containers(containers)
        if not self.scanner.ready:
            return
        res, at = self.bg.get(budget=budget, max_age=DISCOVER_EVERY_SEC * 3)
        if isinstance(res, Exception):
            # Только тип: текст исключения разбора мог бы процитировать конфигурацию nginx.
            if self.logged_error != type(res).__name__:
                self.logged_error = type(res).__name__
                log("домены: сбой сбора (%s)" % self.logged_error)
            return
        if not res:
            return
        # Отказы nginx -T — в каждом отчёте, пока они есть: консоль держит их в снимке хоста (≤ 20 имён), а сам
        # список доменов — только при изменении.
        if res["failed"]:
            payload["domainsFailed"] = res["failed"]
        # Обрезка по DOMAINS_MAX — тоже в каждом отчёте: консоль покажет, что видны не все имена хоста.
        if res["total"] > len(res["rows"]):
            payload["domainsTotal"] = res["total"]
        fp = hashlib.sha256(json.dumps(res["rows"], sort_keys=True).encode()).hexdigest()
        self.pending = None
        if fp == self.sent_fp and time.time() - self.sent_at < self.RESEND_SEC:
            return
        payload["domains"] = res["rows"]
        payload["domainsAt"] = int(at)
        payload["domainsTotal"] = res["total"]
        self.pending = fp

    def delivered(self):
        if self.pending:
            self.sent_fp, self.sent_at, self.pending = self.pending, time.time(), None
