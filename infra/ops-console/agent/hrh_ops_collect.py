"""
HR Helper Ops — сборщики метрик хоста для агента (hrh-ops-agent.py). Только stdlib python3.

Хост: CPU (дельта /proc/stat), память, диски, сеть, uptime; docker: состояние, health,
счётчик перезапусков, код выхода, restart policy, CPU/RAM; nginx: запросы и ошибки за минуту;
бизнес-метрики — shell-команды из BUSINESS_CMDS (их задаёт администратор хоста, не консоль).
"""
import calendar
import fnmatch
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

def log(msg):
    sys.stderr.write("[hrh-ops-agent] %s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    sys.stderr.flush()


def run(cmd, timeout=15):
    """Команда без shell; возвращает (код, stdout, stderr)."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", "%s: команда не найдена" % cmd[0]
    except subprocess.TimeoutExpired:
        return 124, "", "таймаут %s с" % timeout


# ── Метрики хоста ───────────────────────────────────────────────────────────


class HostSampler:
    """Дельты CPU и сети между циклами — без sleep внутри сбора."""

    def __init__(self):
        self.prev_cpu = None
        self.prev_net = None

    @staticmethod
    def _read_cpu():
        parts = Path("/proc/stat").read_text().splitlines()[0].split()[1:]
        vals = [int(x) for x in parts]
        return vals[3] + vals[4], sum(vals)

    def cpu(self):
        out = {"cores": os.cpu_count() or 1}
        try:
            l1, l5, l15 = os.getloadavg()
            out.update(load1=round(l1, 2), load5=round(l5, 2), load15=round(l15, 2))
        except OSError:
            pass
        if Path("/proc/stat").exists():
            cur = self._read_cpu()
            if self.prev_cpu:
                didle, dtotal = cur[0] - self.prev_cpu[0], cur[1] - self.prev_cpu[1]
                if dtotal > 0:
                    out["pct"] = round((1 - didle / dtotal) * 100, 1)
            self.prev_cpu = cur
        elif "load1" in out:
            # macOS/dev: грубая оценка по load average — для локальной отладки, не для прода.
            out["pct"] = round(min(100.0, out["load1"] / out["cores"] * 100), 1)
        return out

    @staticmethod
    def memory():
        meminfo = Path("/proc/meminfo")
        if meminfo.exists():
            info = {}
            for line in meminfo.read_text().splitlines():
                k, _, v = line.partition(":")
                info[k] = int(v.strip().split()[0])
            total = info.get("MemTotal", 0) / 1024
            avail = info.get("MemAvailable", 0) / 1024
            swap_total = info.get("SwapTotal", 0) / 1024
            swap_free = info.get("SwapFree", 0) / 1024
            return {"totalMb": round(total), "usedMb": round(total - avail), "swapTotalMb": round(swap_total), "swapUsedMb": round(swap_total - swap_free)}
        if platform.system() == "Darwin":
            code, total_raw, _ = run(["sysctl", "-n", "hw.memsize"], 5)
            code2, vm, _ = run(["vm_stat"], 5)
            if code == 0 and code2 == 0:
                page = 16384 if "page size of 16384" in vm else 4096
                pages = {m.group(1): int(m.group(2)) for m in re.finditer(r"^(.+?):\s+(\d+)\.", vm, re.M)}
                free = pages.get("Pages free", 0) + pages.get("Pages inactive", 0) + pages.get("Pages speculative", 0)
                total = int(total_raw.strip()) / 1048576
                return {"totalMb": round(total), "usedMb": round(total - free * page / 1048576)}
        return {}

    def network(self, elapsed):
        path = Path("/proc/net/dev")
        if not path.exists():
            return None
        rx = tx = errs = 0
        for line in path.read_text().splitlines()[2:]:
            iface, _, data = line.partition(":")
            iface = iface.strip()
            if iface == "lo" or iface.startswith(("veth", "docker", "br-")):
                continue
            cols = data.split()
            rx += int(cols[0])
            tx += int(cols[8])
            # Ошибки приёма и передачи (errs) — растущий счётчик; в отчёт — прирост за интервал.
            errs += int(cols[2]) + int(cols[10])
        out = None
        if self.prev_net and elapsed > 0:
            out = {
                "rxBytesPerSec": round((rx - self.prev_net[0]) / elapsed),
                "txBytesPerSec": round((tx - self.prev_net[1]) / elapsed),
                "errors": max(0, errs - self.prev_net[2]),
            }
        self.prev_net = (rx, tx, errs)
        return out


def disks(mounts):
    out = []
    for m in mounts:
        try:
            du = shutil.disk_usage(m)
            item = {"mount": m, "totalGb": round(du.total / 1e9, 1), "usedGb": round(du.used / 1e9, 1)}
            # Иноды: диск может «кончиться» при свободных гигабайтах (миллионы мелких файлов).
            st = os.statvfs(m)
            if st.f_files:
                item["inodePct"] = round((st.f_files - st.f_ffree) * 100 / st.f_files, 1)
            out.append(item)
        except OSError:
            pass
    return out


def os_name():
    """Дистрибутив для людей: «Ubuntu 24.04.1 LTS» из /etc/os-release; нет файла — None."""
    p = Path("/etc/os-release")
    try:
        for line in p.read_text().splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip().strip('"')[:120]
    except OSError:
        return None
    return None


def uptime_sec():
    p = Path("/proc/uptime")
    if p.exists():
        return int(float(p.read_text().split()[0]))
    code, out, _ = run(["sysctl", "-n", "kern.boottime"], 5)
    m = re.search(r"sec = (\d+)", out) if code == 0 else None
    return int(time.time()) - int(m.group(1)) if m else None


# ── Docker ──────────────────────────────────────────────────────────────────

UNITS = {"b": 1 / 1048576, "kib": 1 / 1024, "kb": 1 / 1000, "mib": 1, "mb": 1, "gib": 1024, "gb": 1000, "tib": 1048576}


def parse_mem(raw):
    m = re.match(r"\s*([\d.]+)\s*([A-Za-z]+)", raw or "")
    if not m:
        return None
    return round(float(m.group(1)) * UNITS.get(m.group(2).lower(), 1), 1)


def last_health_output(state):
    """Вывод последней проверки healthcheck: почему контейнер unhealthy (curl: Connection refused…)."""
    log = ((state.get("Health") or {}).get("Log") or [])[-1:] or [{}]
    entry = log[0] or {}
    out = " ".join(str(entry.get("Output") or "").split())
    if not out and entry.get("ExitCode") not in (None, 0):
        out = "код выхода %s" % entry.get("ExitCode")
    return out[:380]


# cgroup v2 контейнера: systemd-драйвер docker — system.slice/docker-<id>.scope, cgroupfs — docker/<id>.
CGROUP_BASES = ("/sys/fs/cgroup/system.slice/docker-{id}.scope", "/sys/fs/cgroup/docker/{id}")


def _cgroup_mb(path):
    try:
        with open(path) as f:
            return round(int(f.read().strip()) / 1048576, 1)
    except (OSError, ValueError):
        return None


def cgroup_memory(container_id, bases=CGROUP_BASES):
    """(пик памяти, пик swap) контейнера с его запуска в МБ из cgroup v2; только чтение. По пику swap видно, что
    контейнер упирался в потолок и уходил в swap хоста, даже если ядро никого не убило. Нет файла — None."""
    for tpl in bases:
        base = tpl.format(id=container_id)
        if os.path.isdir(base):
            return _cgroup_mb(base + "/memory.peak"), _cgroup_mb(base + "/memory.swap.peak")
    return None, None


# ── Нехватка памяти (OOM) ───────────────────────────────────────────────────
# Счёт — по журналу ядра, а не по счётчику oom_kill в cgroup: когда ядро убивает главный процесс, контейнер
# перезапускается с тем же id, systemd за 0–3 с пересоздаёт его scope, и memory.events начинается с нуля — такой
# случай терялся (whisper 05.10, диаризация 16.10). Журнал читается от курсора не чаще раза в минуту (на проде
# 17 мс; первое чтение за 3 суток — 0,2 с), итог по id контейнера только растёт и хранится в StateDirectory:
# переживает перезапуск и контейнера, и агента.

OOM_VICTIM_CG = re.compile(r"\btask_memcg=[^,\s]*?(?:docker-|/docker/)([0-9a-f]{64})")
OOM_TASK = re.compile(r"\btask=([^,\s]+)")
OOM_WINDOW_SEC = 3 * 86400
OOM_READ_EVERY_SEC = 60
OOM_RECENT_MAX = 50


def read_kernel_journal(cursor):
    """(строки, курсор) журнала ядра после курсора, а без него — за 3 суток; не прочитан — (None, None).
    Имя процесса задаёт сам процесс: байты не в UTF-8 заменяются, а не роняют сбор контейнеров."""
    cmd = ["journalctl", "-k", "-o", "short-unix", "--no-pager", "--show-cursor"]
    cmd += ["--after-cursor", cursor] if cursor else ["--since", "-3 days"]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None, None
    if p.returncode != 0:
        return None, None
    lines, new_cursor = [], cursor
    for line in p.stdout.decode("utf-8", "replace").splitlines():
        if line.startswith("-- cursor: "):
            new_cursor = line[len("-- cursor: "):].strip()
        elif line[:1].isdigit():
            lines.append(line)
    return lines, new_cursor


class OomJournal:
    """Кого ядро убило по нехватке памяти — по id контейнера: всего (растёт монотонно) и кого именно за 3 суток.
    Строка ядра: «<время> <хост> kernel: oom-kill:…,oom_memcg=…|global_oom,task_memcg=…docker-<id>.scope,task=<имя>,…»;
    global_oom — кончилась память всего хоста, а не потолок контейнера. Журнал агенту доступен через группу adm.
    Сбор контейнеров идёт в одном фоновом потоке (Background), поэтому без блокировок."""

    def __init__(self, state_dir=None, reader=read_kernel_journal, clock=time.time):
        self.path = os.path.join(state_dir, "oom.json") if state_dir else None
        self.reader, self.clock = reader, clock
        self.cursor = None
        self.total = {}  # id → убито всего
        self.recent = {}  # id → [[время, имя, "host" | "memcg"], …] за 3 суток
        self.ready = False  # итоги отправляются, только когда журнал прочитан (или загружен с прошлого запуска)
        self.read_at = 0.0
        self.warned = False
        self._load()

    def _load(self):
        if not self.path:
            return
        try:
            with open(self.path) as f:
                d = json.load(f)
            self.cursor = d.get("cursor") or None
            self.total = {k: int(v) for k, v in (d.get("total") or {}).items()}
            self.recent = {k: [list(e) for e in v] for k, v in (d.get("recent") or {}).items()}
            self.ready = True
        except (OSError, ValueError, TypeError, AttributeError):
            pass

    def _save(self):
        if not self.path:
            return
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump({"cursor": self.cursor, "total": self.total, "recent": self.recent}, f)
            os.replace(tmp, self.path)
        except OSError as e:
            log("учёт OOM не сохранён (%s): после перезапуска агента итоги начнутся заново" % e)

    def refresh(self, container_ids):
        """Новые строки журнала → итоги. Не чаще раза в OOM_READ_EVERY_SEC; container_ids — все контейнеры хоста
        (docker ps -a): удалённые забываются, чтобы файл не рос с каждым пересозданием."""
        now = self.clock()
        if now - self.read_at < OOM_READ_EVERY_SEC:
            return
        self.read_at = now
        before = (self.cursor, json.dumps(self.total, sort_keys=True), json.dumps(self.recent, sort_keys=True))
        lines, cursor = self.reader(self.cursor)
        if lines is None and self.cursor:
            # Курсор не принят (журнал очищен или ротирован) — заново за 3 суток; уже учтённое отсеется ниже.
            lines, cursor = self.reader(None)
        if lines is None:
            if not self.warned:
                log("журнал ядра не читается (агенту нужна группа adm) — нехватка памяти в контейнерах не учитывается")
                self.warned = True
            return
        self.warned = False
        seen = {(e[0], cid, e[1]) for cid, es in self.recent.items() for e in es}
        for line in lines:
            if "oom-kill:" not in line:
                continue
            m = OOM_VICTIM_CG.search(line)
            if not m:
                continue
            try:
                ts = round(float(line.split(" ", 1)[0]), 6)
            except ValueError:
                continue
            t = OOM_TASK.search(line)
            cid, task = m.group(1), (t.group(1)[:64] if t else "?")
            if (ts, cid, task) in seen:
                continue
            seen.add((ts, cid, task))
            self.total[cid] = self.total.get(cid, 0) + 1
            self.recent.setdefault(cid, []).append([ts, task, "host" if "global_oom" in line else "memcg"])
        cutoff, live = now - OOM_WINDOW_SEC, set(container_ids)
        for cid in list(self.recent):
            kept = [e for e in self.recent[cid] if e[0] >= cutoff][-OOM_RECENT_MAX:]
            if kept and cid in live:
                self.recent[cid] = kept
            else:
                del self.recent[cid]
        for cid in [c for c in self.total if c not in live]:
            del self.total[cid]
        self.cursor = cursor or self.cursor
        self.ready = True
        if (self.cursor, json.dumps(self.total, sort_keys=True), json.dumps(self.recent, sort_keys=True)) != before:
            self._save()

    def victims_text(self, container_id):
        """«pluginsmanager ×4, uvicorn ×1 (память хоста)» — кого убило ядро за 3 суток; никого — None."""
        names = {}
        for _, task, kind in self.recent.get(container_id, ()):
            names[(task, kind)] = names.get((task, kind), 0) + 1
        if not names:
            return None
        ranked = sorted(names.items(), key=lambda kv: (-kv[1], kv[0]))
        return ", ".join("%s ×%d%s" % (t, k, " (память хоста)" if kind == "host" else "") for (t, kind), k in ranked)[:200]


def docker_containers(cfg):
    """Возвращает (контейнеры, ошибка). Ошибка — docker недоступен: консоль не трогает алерты контейнеров."""
    code, out, err = run(["docker", "ps", "-a", "-q", "--no-trunc"], 15)
    if code != 0:
        return None, (err or "docker ps failed").strip()[:300]
    ids = out.split()
    if not ids:
        return [], None
    code, out, err = run(["docker", "inspect"] + ids, 20)
    if code != 0:
        return None, (err or "docker inspect failed").strip()[:300]
    items = json.loads(out)
    oom = getattr(cfg, "oom", None)
    if oom is not None:
        try:
            oom.refresh([it.get("Id") for it in items if it.get("Id")])
        except Exception as e:  # noqa: BLE001 — учёт OOM не должен ронять снимок контейнеров
            log("учёт OOM: сбой чтения журнала: %s" % e)
    result = {}
    for it in items:
        labels = (it.get("Config") or {}).get("Labels") or {}
        name = (it.get("Name") or "").lstrip("/")
        # Видны все контейнеры хоста, любого compose-проекта и без него; скрыть шум — OPS_CONTAINER_EXCLUDE.
        if any(fnmatch.fnmatch(name, p) for p in getattr(cfg, "container_exclude", [])):
            continue
        state = it.get("State") or {}
        health = (state.get("Health") or {}).get("Status") or "none"
        started = state.get("StartedAt") or ""
        project = labels.get("com.docker.compose.project", "")[:120]
        c = {
            "name": name,
            "image": (it.get("Config") or {}).get("Image", "")[:300],
            "state": state.get("Status", "unknown"),
            "health": health,
            "status": ("%s%s" % (state.get("Status", ""), " (%s)" % health if health != "none" else ""))[:255],
            "restartCount": int(it.get("RestartCount") or 0),
            "exitCode": int(state.get("ExitCode") or 0),
            "restartPolicy": ((it.get("HostConfig") or {}).get("RestartPolicy") or {}).get("Name", ""),
            "composeService": labels.get("com.docker.compose.service", "")[:120],
            "composeProject": project,
            # Вывод healthcheck чужого стека может процитировать секрет — уходит только у стека продукта.
            "healthLog": last_health_output(state) if project == cfg.compose_project or not cfg.compose_project else "",
            "oomKilled": bool(state.get("OOMKilled")),
        }
        if started and not started.startswith("0001-"):
            c["startedAt"] = started[:64]
        if c["state"] == "running" and it.get("Id"):
            peak, swap_peak = cgroup_memory(it["Id"])
            if peak is not None:
                c["memPeakMb"] = peak
            if swap_peak is not None:
                c["swapPeakMb"] = swap_peak
        # Итог по журналу — и у остановленного контейнера: ядро могло убить его главный процесс.
        if oom is not None and oom.ready and it.get("Id"):
            c["oomKills"] = oom.total.get(it["Id"], 0)
            victims = oom.victims_text(it["Id"])
            if victims:
                c["oomVictims"] = victims
        if labels.get("ops.stateful") in ("true", "false"):
            c["stateful"] = labels["ops.stateful"] == "true"
        if any(fnmatch.fnmatch(name, p) for p in cfg.stateful):
            c["stateful"] = True
        result[name] = c
    code, out, _ = run(["docker", "stats", "--no-stream", "--format", "{{json .}}"], 25)
    if code == 0:
        for line in out.splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            c = result.get(row.get("Name"))
            if not c:
                continue
            try:
                c["cpuPct"] = round(float(str(row.get("CPUPerc", "0")).rstrip("%")), 2)
            except ValueError:
                pass
            used, _, limit = str(row.get("MemUsage", "")).partition("/")
            if parse_mem(used) is not None:
                c["memMb"] = parse_mem(used)
            if parse_mem(limit) is not None:
                c["memLimitMb"] = parse_mem(limit)
    return list(result.values()), None


# ── nginx и бизнес-метрики ──────────────────────────────────────────────────

LOG_TS = re.compile(r"\[(\d{2})/(\w{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\]")
MONTHS = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


UUID_SEG = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
HEX_SEG = re.compile(r"^[0-9a-fA-F]{16,}$")
TOKEN_SEG = re.compile(r"^[A-Za-z0-9_-]{24,}$")
FILE_SEG = re.compile(r"^[^/]+\.[A-Za-z0-9]{1,5}$")
ROUTE_DEPTH = 5


def route_of(raw):
    """Путь запроса → шаблон маршрута для «топа путей»: id, хэши, токены и имена файлов
    заменяются метками. Так одинаковые маршруты складываются, а в консоль не уходят
    идентификаторы, ключи объектов хранилища и имена загруженных файлов."""
    path = raw.split("?", 1)[0].split("#", 1)[0]
    if not path.startswith("/"):
        return "(не путь)"
    segs = path.split("/")[1:]
    out = []
    for i, seg in enumerate(segs[:ROUTE_DEPTH]):
        if not seg:
            out.append("")
        elif UUID_SEG.match(seg):
            out.append(":id")
        elif seg.isdigit():
            out.append(":n")
        elif "%" in seg or HEX_SEG.match(seg) or TOKEN_SEG.match(seg):
            out.append(":x")
        elif i > 0 and FILE_SEG.match(seg):
            out.append(":file")
        else:
            out.append(seg[:40])
    if len(segs) > ROUTE_DEPTH:
        out.append("…")
    return "/" + "/".join(out)


def nginx_stats(path_str):
    """nginx на самом сервере: хвост access.log (последний мегабайт)."""
    path = Path(path_str)
    if not path.exists():
        return None
    try:
        with path.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 1024 * 1024))
            lines = f.read().decode("utf-8", "replace").splitlines()[1:]
    except OSError:
        return None
    return access_stats(lines)


# Трафик nginx из Docker — счётчики за минуту (requestsPerMin). Сбор раз в минуту, но по 15-секундному
# циклу агента: фактический шаг 60–75 с. Минута считается от момента разбора, а он позже вызова
# docker logs (до таймаута 10 с), поэтому окно чтения шире окна счёта: иначе край минуты терялся бы
# и трафик недосчитывался. Перекрытие чтений двойного счёта не даёт — каждый сбор заново считает
# только последние 60 с.
NGINX_COUNT_WINDOW_S = 60
NGINX_READ_WINDOW_S = 75
NGINX_MIN_INTERVAL_S = 60
# Потолок строк на случай наплыва трафика: столько строк за минуту — уже повод смотреть сервер.
NGINX_MAX_LINES = 20000


def nginx_container_stats(name):
    """nginx в Docker: access-лог идёт в stdout контейнера — берём его через `docker logs`
    (stderr контейнера — это error-лог, он не нужен). Зовётся раз в минуту (nginx_background), так
    что dockerd не разбирает тысячи строк каждые 15 с."""
    cmd = ["docker", "logs", "--since", "%ds" % NGINX_READ_WINDOW_S, "--tail", str(NGINX_MAX_LINES), name]
    code, out, err = run(cmd, timeout=10)
    if code != 0:
        raise RuntimeError("docker logs %s: %s" % (name, (err or "код %d" % code).strip()[:200]))
    return access_stats(out.splitlines())


def nginx_background(container_name):
    """Фоновый сбор трафика nginx-контейнера не чаще раза в NGINX_MIN_INTERVAL_S;
    container_name() — имя текущего контейнера (он меняется при пересоздании)."""
    return Background(lambda: nginx_container_stats(container_name()), min_interval=NGINX_MIN_INTERVAL_S)


def find_nginx_container(containers, project=""):
    """Контейнер nginx продукта: запущенный сервис compose «nginx» основного проекта (OPS_COMPOSE_PROJECT;
    агент видит контейнеры всех проектов, nginx может быть и у соседнего стека)."""
    for c in containers or []:
        if c.get("composeService") == "nginx" and c.get("state") == "running" and (not project or c.get("composeProject") == project):
            return c.get("name")
    return None


def access_stats(lines):
    now = time.time()
    total = e4 = e5 = 0
    top = {}
    for line in lines:
        m = LOG_TS.search(line)
        if not m:
            continue
        tz = int(m.group(7))
        offset = (abs(tz) // 100 * 3600 + abs(tz) % 100 * 60) * (1 if tz >= 0 else -1)
        try:
            ts = calendar.timegm((int(m.group(3)), MONTHS.get(m.group(2), 1), int(m.group(1)), int(m.group(4)), int(m.group(5)), int(m.group(6)), 0, 0, 0)) - offset
        except (ValueError, OverflowError):
            continue
        if now - ts > NGINX_COUNT_WINDOW_S:
            continue
        total += 1
        sm = re.search(r'"\s(\d{3})\s', line)
        code = sm.group(1) if sm else ""
        if code.startswith("4"):
            e4 += 1
        elif code.startswith("5"):
            e5 += 1
        pm = re.search(r'"(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)', line)
        if pm:
            p = route_of(pm.group(1))[:120]
            top[p] = top.get(p, 0) + 1
    return {"requestsPerMin": total, "errors4xxPerMin": e4, "errors5xxPerMin": e5, "topPaths": sorted(top.items(), key=lambda kv: -kv[1])[:10]}


def business_metrics(cmds):
    """(значения, имена упавших команд). Упавшая — код выхода не 0, не число в последней строке или таймаут:
    число, напечатанное перед ошибкой, не засчитывается (иначе сбой чтения выглядел бы как «0 — всё в норме»)."""
    out, failed = {}, []
    for name, cmd in list(cmds.items())[:20]:
        key = str(name)[:48]
        try:
            # shell=True — команды задаёт администратор сервера в env-файле агента, не консоль.
            p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=20)
            if p.returncode != 0:
                raise ValueError("код %d" % p.returncode)
            out[key] = float(p.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError, subprocess.TimeoutExpired):
            failed.append(key)
    return out, failed


# ── Фоновый сбор ────────────────────────────────────────────────────────────


class Background:
    """Медленный сбор (docker CLI, бизнес-команды) идёт в фоновом потоке: отчёт уходит по
    расписанию с последним результатом, а не ждёт перегруженный хост или зависший dockerd.
    Новый сбор не стартует, пока не закончился предыдущий, — зависшие команды не копятся;
    min_interval — не чаще раза в столько секунд (тяжёлые запросы к базе и т.п.)."""

    def __init__(self, fn, min_interval=0):
        self.fn = fn
        self.min_interval = min_interval
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.thread = None
        self.value = None
        self.at = 0.0

    def _run(self):
        try:
            value = self.fn()
        except Exception as e:  # noqa: BLE001 — сбой сбора не должен ронять агента
            value = e
        with self.lock:
            self.value, self.at = value, time.time()
        self.done.set()

    def get(self, budget, max_age):
        """Ждёт свежий результат до budget секунд. Возвращает (значение, когда получено), если
        результат не старше max_age, иначе (None, когда получен последний результат или 0)."""
        with self.lock:
            idle = self.thread is None or not self.thread.is_alive()
            due = not self.at or time.time() - self.at >= self.min_interval
            if idle and due:
                self.done.clear()
                self.thread = threading.Thread(target=self._run, daemon=True)
                self.thread.start()
        self.done.wait(budget)
        with self.lock:
            value, at = self.value, self.at
        if at and time.time() - at <= max_age:
            return value, at
        return None, at
