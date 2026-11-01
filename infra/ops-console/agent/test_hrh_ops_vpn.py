"""Тесты VPN: сборщик hrh-ops-vpnd.py и чтение его файла агентом. python3 -m unittest discover -s agent (только stdlib)."""
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

import hrh_ops_vpn as hv

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("hrh_ops_vpnd", os.path.join(HERE, "hrh-ops-vpnd.py"))
assert _spec and _spec.loader
vd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vd)

NOW = 1_800_000_000.0


def wg_runner(now, transfer_a=(1000, 5000), calls=None):
    tables = {
        "allowed-ips": "wg0\tKEYA=\t10.77.0.2/32\nwg0\tKEYB=\t10.77.0.3/32 fd00::3/128\nwg1\tKEYC=\t10.9.0.0/24\n",
        "latest-handshakes": "wg0\tKEYA=\t%d\nwg0\tKEYB=\t0\nwg1\tKEYC=\t%d\n" % (now - 30, now - 500),
        "transfer": "wg0\tKEYA=\t%d\t%d\nwg0\tKEYB=\t0\t0\nwg1\tKEYC=\t7\t9\n" % transfer_a,
        "endpoints": "wg0\tKEYA=\t203.0.113.7:51820\nwg0\tKEYB=\t(none)\nwg1\tKEYC=\t198.51.100.1:4000\n",
    }

    def run(argv, timeout):
        if calls is not None:
            calls.append(argv)
        if argv[:3] == ["wg", "show", "all"]:
            return tables.get(argv[3])
        return None

    return run


CT = """ipv4     2 tcp      6 431999 ESTABLISHED src=10.77.0.2 dst=140.82.121.4 sport=51234 dport=443 packets=10 bytes=1500 src=140.82.121.4 dst=173.212.238.170 sport=443 dport=51234 packets=12 bytes=9000 [ASSURED] mark=0 zone=0 use=2
ipv4     2 udp      17 25 src=10.77.0.2 dst=1.1.1.1 sport=5353 dport=53 packets=1 bytes=60 src=1.1.1.1 dst=173.212.238.170 sport=53 dport=5353 packets=1 bytes=120 mark=0 zone=0 use=2
ipv4     2 icmp     1 29 src=10.9.0.5 dst=8.8.8.8 type=8 code=0 id=17 packets=1 bytes=84 src=8.8.8.8 dst=173.212.238.170 type=0 code=0 id=17 packets=1 bytes=84 mark=0 use=2
ipv4     2 tcp      6 100 ESTABLISHED src=172.18.0.5 dst=10.0.0.1 sport=40000 dport=5432 packets=3 bytes=300 src=10.0.0.1 dst=172.18.0.5 sport=5432 dport=40000 packets=3 bytes=300 [ASSURED] mark=0 use=1
"""


class WgTest(unittest.TestCase):
    def test_peers_without_keys_and_without_dump(self):
        calls = []
        peers = vd.read_peers(wg_runner(NOW, calls=calls))
        self.assertEqual([p["ip"] for p in peers], ["10.77.0.2", "10.77.0.3", "10.9.0.0/24"])
        a = peers[0]
        self.assertEqual((a["rx"], a["tx"], a["endpoint"], a["handshakeAt"]), (1000, 5000, "203.0.113.7:51820", NOW - 30))
        self.assertEqual(peers[1]["endpoint"], "")
        self.assertEqual(peers[1]["allowed"], ["10.77.0.3/32", "fd00::3/128"])
        for argv in calls:
            self.assertNotIn("dump", argv)
            self.assertNotIn("private-key", argv)
            self.assertNotIn("preshared-keys", argv)

    def test_no_wg(self):
        self.assertIsNone(vd.read_peers(lambda argv, timeout: None))

    def test_snapshot_has_no_public_keys(self):
        c = vd.Collector(30, runner=wg_runner(NOW), pinger=lambda ip: None, ct_source=lambda r: ("none", None))
        snap = c.scan(NOW)
        self.assertNotIn("KEY", json.dumps(snap))
        self.assertEqual(snap["wg"], "ok")


class FlowTest(unittest.TestCase):
    def setUp(self):
        self.peer_of = vd.PeerOf(vd.read_peers(wg_runner(NOW)))

    def test_parse_only_peer_sources(self):
        rows = [r for r in (vd.parse_flow(line, self.peer_of) for line in CT.splitlines()) if r]
        self.assertEqual(len(rows), 3)
        key, peer, up, down = rows[0]
        self.assertEqual((peer, key[0], key[2], key[4], up, down), ("10.77.0.2", "tcp", "140.82.121.4", 443, 1500, 9000))
        icmp = rows[2]
        self.assertEqual((icmp[1], icmp[0][0], icmp[0][4]), ("10.9.0.0/24", "icmp", 0))

    def test_deltas_new_and_reset(self):
        t = vd.FlowTracker()
        k1 = ("tcp", "10.77.0.2", "1.2.3.4", "1000", 443)
        agg, _, warm, _ = t.scan([(k1, "10.77.0.2", 100, 200)])
        self.assertFalse(warm)
        self.assertEqual(agg, {})
        k2 = ("udp", "10.77.0.2", "1.1.1.1", "5353", 53)
        agg, _, warm, n = t.scan([(k1, "10.77.0.2", 150, 260), (k2, "10.77.0.2", 60, 120)])
        self.assertTrue(warm)
        self.assertEqual(n, 2)
        self.assertEqual(agg[("10.77.0.2", "tcp", "1.2.3.4", 443)], [50, 60, 0])
        self.assertEqual(agg[("10.77.0.2", "udp", "1.1.1.1", 53)], [60, 120, 1])
        # Та же пятёрка после закрытия: счётчик меньше прошлого — это новое соединение, считаем с нуля.
        agg, _, _, _ = t.scan([(k1, "10.77.0.2", 30, 40)])
        self.assertEqual(agg[("10.77.0.2", "tcp", "1.2.3.4", 443)], [30, 40, 0])

    def test_without_acct_counts_connections(self):
        t = vd.FlowTracker()
        k = ("tcp", "10.77.0.2", "1.2.3.4", "1000", 443)
        t.scan([])
        agg, _, _, _ = t.scan([(k, "10.77.0.2", -1, -1)])
        self.assertEqual(agg[("10.77.0.2", "tcp", "1.2.3.4", 443)], [0, 0, 1])
        agg, _, _, _ = t.scan([(k, "10.77.0.2", -1, -1)])
        self.assertEqual(agg, {})

    def test_cap(self):
        t = vd.FlowTracker()
        rows = [(("tcp", "10.77.0.2", "1.2.3.%d" % (i % 250), str(i), 443), "10.77.0.2", 1, 1) for i in range(vd.FLOWS_MAX + 5)]
        _, truncated, _, n = t.scan(iter(rows))
        self.assertTrue(truncated)
        self.assertEqual(n, vd.FLOWS_MAX)


class CollectorTest(unittest.TestCase):
    def test_rates_ping_and_top(self):
        pings = []
        state = {"tr": (1000, 5000), "ct": CT, "now": NOW}
        c = vd.Collector(
            30,
            runner=lambda argv, timeout: wg_runner(state["now"], state["tr"])(argv, timeout),
            pinger=lambda ip: pings.append(ip) or (12.34, 0.0),
            ct_source=lambda r: ("proc", state["ct"].splitlines()),
        )
        s1 = c.scan(NOW)
        a = s1["peers"][0]
        self.assertIsNone(a["rxBps"])
        self.assertEqual((a["rttMs"], a["lossPct"]), (12.34, 0.0))
        self.assertEqual(pings, ["10.77.0.2"])  # B без рукопожатия, C — сеть, а не адрес
        self.assertFalse(s1["flows"]["warm"])
        state["tr"] = (31000, 8000)
        state["ct"] = CT.replace("bytes=1500", "bytes=4500")
        s2 = c.scan(NOW + 30)
        a = s2["peers"][0]
        self.assertEqual((a["rxBps"], a["txBps"]), (1000.0, 100.0))
        self.assertEqual(pings, ["10.77.0.2"])  # раз в 5 мин, не чаще
        self.assertTrue(s2["flows"]["warm"])
        self.assertEqual(s2["flows"]["top"], [["10.77.0.2", "tcp", "140.82.121.4", 443, 3000, 0, 0]])
        # Через 5 мин, и с пира пришло больше порога — пинг снова.
        state["tr"] = (31000 + 10000, 8000)
        state["now"] = NOW + 330
        c.scan(NOW + 330)
        self.assertEqual(pings, ["10.77.0.2", "10.77.0.2"])

    def test_idle_peer_not_pinged_again(self):
        pings = []
        c = vd.Collector(30, runner=wg_runner(NOW), pinger=lambda ip: pings.append(ip) or (5.0, 0.0), ct_source=lambda r: ("none", None))
        c.scan(NOW)
        c.scan(NOW + 400)  # рукопожатие свежее, но трафика с прошлого пинга нет — не будим
        self.assertEqual(pings, ["10.77.0.2"])

    def test_counter_reset_gives_no_rate(self):
        state = {"tr": (5000, 5000)}
        c = vd.Collector(30, runner=lambda a, t: wg_runner(NOW, state["tr"])(a, t), pinger=lambda ip: None, ct_source=lambda r: ("none", None))
        c.scan(NOW)
        state["tr"] = (10, 10)
        self.assertIsNone(c.scan(NOW + 30)["peers"][0]["rxBps"])

    def test_write_atomic_mode(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "vpn.json")
            vd.write_atomic(path, {"v": 1})
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o640)
            with open(path) as f:
                self.assertEqual(json.load(f), {"v": 1})
            self.assertEqual(os.listdir(d), ["vpn.json"])


def helper_snapshot(at, seq, started=NOW - 1000, warm=True, top=None, wg="ok"):
    return {
        "v": 1,
        "at": at,
        "started": started,
        "seq": seq,
        "interval": 30,
        "wg": wg,
        "peers": [
            {"iface": "wg0", "ip": "10.77.0.2", "handshakeAt": at - 20, "endpoint": "203.0.113.7:51820", "rx": 10, "tx": 20, "rxBps": 1.5, "txBps": 2.5, "rttMs": 40.1, "lossPct": 0.0, "pingAt": at - 60},
            {"iface": "wg0", "ip": "10.77.0.3", "handshakeAt": 0, "endpoint": "", "rx": 0, "tx": 0, "rxBps": None, "txBps": None},
        ],
        "flows": {"source": "proc", "acct": True, "warm": warm, "truncated": False, "count": 3, "top": top or [], "other": [5, 5, 1]},
    }


class FeedTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "vpn.json")
        self.clock = [NOW]
        self.ptr = hv.Ptr(enabled=False)

    def tearDown(self):
        self.dir.cleanup()

    def feed(self, state=True):
        return hv.VpnFeed(self.path, hv.parse_names("10.77.0.2=Mac, bad, =x"), self.dir.name if state else None, self.ptr, clock=lambda: self.clock[0])

    def write(self, snap):
        with open(self.path, "w") as f:
            json.dump(snap, f)

    def test_no_helper_no_vpn(self):
        payload = {}
        self.feed().attach(payload)
        self.assertNotIn("vpn", payload)

    def test_bad_file(self):
        with open(self.path, "w") as f:
            f.write("{not json")
        payload = {}
        self.feed().attach(payload)
        self.assertEqual(payload["vpn"], {"state": "error", "error": "bad_file"})

    def test_peers_and_destinations_once_per_snapshot(self):
        top = [["10.77.0.2", "tcp", "140.82.121.4", 443, 3000, 9000, 2], ["10.77.0.2", "udp", "1.1.1.1", 53, 60, 120, 1]]
        self.write(helper_snapshot(NOW - 5, 7, top=top))
        f = self.feed()
        p = {}
        f.attach(p)
        v = p["vpn"]
        self.assertEqual(v["state"], "ok")
        mac, other = v["peers"]
        self.assertEqual((mac["name"], mac["online"], mac["handshakeAgeSec"], mac["rttMs"], mac["endpoint"]), ("Mac", True, 25, 40.1, "203.0.113.7:51820"))
        self.assertEqual((other["name"], other["online"], other["handshakeAgeSec"]), ("10.77.0.3", False, None))
        self.assertNotIn("rxBps", other)
        rows = v["destinations"]["h1"]["rows"]
        self.assertEqual([(r["peer"], r["dst"], r["port"], r["up"], r["down"], r["conns"]) for r in rows], [("Mac", "140.82.121.4", 443, 3000, 9000, 2), ("Mac", "1.1.1.1", 53, 60, 120, 1)])
        self.assertEqual(v["destinations"]["h24"]["total"], [3065, 9125, 4])
        self.assertEqual(v["destinations"]["h1"]["keys"], 2)
        # Тот же снимок — направлений нет (они уже в консоли), пиры есть.
        p = {}
        f.attach(p)
        self.assertNotIn("destinations", p["vpn"])
        self.assertEqual(len(p["vpn"]["peers"]), 2)
        # Следующий снимок копится в окна, но в отчёт направления идут не чаще DEST_EVERY.
        self.write(helper_snapshot(NOW + 25, 8, top=top[:1]))
        self.clock[0] = NOW + 30
        p = {}
        f.attach(p)
        self.assertNotIn("destinations", p["vpn"])
        self.write(helper_snapshot(NOW + hv.DEST_EVERY - 5, 9, top=top[:1]))
        self.clock[0] = NOW + hv.DEST_EVERY
        p = {}
        f.attach(p)
        self.assertEqual(p["vpn"]["destinations"]["h1"]["rows"][0]["up"], 9000)

    def test_cold_snapshot_not_counted(self):
        self.write(helper_snapshot(NOW - 5, 1, warm=False, top=[["10.77.0.2", "tcp", "1.2.3.4", 443, 1, 1, 1]]))
        p = {}
        self.feed().attach(p)
        self.assertEqual(p["vpn"]["destinations"]["h1"], {"rows": [], "keys": 0, "total": [0, 0, 0]})

    def test_stale(self):
        self.write(helper_snapshot(NOW - 600, 3, top=[["10.77.0.2", "tcp", "1.2.3.4", 443, 1, 1, 1]]))
        p = {}
        self.feed().attach(p)
        v = p["vpn"]
        self.assertEqual(v["state"], "stale")
        self.assertNotIn("destinations", v)
        self.assertFalse(v["peers"][0]["online"])
        self.assertNotIn("rxBps", v["peers"][0])

    def test_survives_restart_without_double_count(self):
        top = [["10.77.0.2", "tcp", "1.2.3.4", 443, 100, 100, 1]]
        self.write(helper_snapshot(NOW - 5, 4, top=top))
        f = self.feed()
        f.attach({})
        f.saved_at = 0
        f._save(NOW + hv.SAVE_EVERY)
        self.assertEqual(stat.S_IMODE(os.stat(f.state).st_mode), 0o600)
        g = self.feed()
        p = {}
        g.attach(p)
        self.assertNotIn("destinations", p["vpn"])  # тот же снимок уже учтён до перезапуска
        self.write(helper_snapshot(NOW + 25, 5, top=top))
        self.clock[0] = NOW + 30
        p = {}
        g.attach(p)
        self.assertEqual(p["vpn"]["destinations"]["h24"]["rows"][0]["up"], 200)


class BucketsTest(unittest.TestCase):
    def test_cap_goes_to_other_and_old_buckets_drop(self):
        b = hv.Buckets(300, 13, 2)
        b.add(NOW, [("a", 1, 1, 1), ("b", 1, 1, 1), ("c", 5, 5, 1)])
        w = b.window(NOW, 3600)
        self.assertEqual(sorted(w), ["*", "a", "b"])
        self.assertEqual(w["*"], [5, 5, 1])
        b.add(NOW + 300 * 14, [("d", 1, 0, 0)])
        self.assertEqual(list(b.window(NOW + 300 * 14, 3600)), ["d"])
        self.assertEqual(len(b.data), 1)


class PtrTest(unittest.TestCase):
    def test_private_never_resolved_and_cache(self):
        asked = []
        fwd = lambda host, port: [(2, 1, 6, "", ("1.1.1.1", 0))]  # noqa: E731
        p = hv.Ptr(enabled=True, resolver=lambda ip: asked.append(ip) or ("one.one.one.one.", [], [ip]), forward=fwd)
        self.assertIsNone(p.name("10.0.0.1"))
        self.assertFalse(p.queued)
        p.resolve_one("1.1.1.1")
        self.assertEqual(p.name("1.1.1.1"), "one.one.one.one")
        self.assertEqual(asked, ["1.1.1.1"])

    def test_spoofed_ptr_not_shown(self):
        # PTR своего адреса пишет кто угодно; прямой запрос по имени ведёт на другой адрес — имени не показываем.
        p = hv.Ptr(enabled=False, resolver=lambda ip: ("accounts.google.com", [], [ip]), forward=lambda h, port: [(2, 1, 6, "", ("142.250.1.1", 0))])
        p.resolve_one("203.0.113.9")
        self.assertIsNone(p.name("203.0.113.9"))
        p6 = hv.Ptr(enabled=False, resolver=lambda ip: ("h.example", [], [ip]), forward=lambda h, port: [(10, 1, 6, "", ("2001:db8:0:0::1", 0, 0, 0))])
        p6.resolve_one("2001:db8::1")
        self.assertEqual(p6.name("2001:db8::1"), "h.example")

    def test_forward_failure_hides_name(self):
        def nx(host, port):
            raise OSError("NXDOMAIN")

        p = hv.Ptr(enabled=False, resolver=lambda ip: ("x.example", [], [ip]), forward=nx)
        p.resolve_one("198.51.100.1")
        self.assertIsNone(p.name("198.51.100.1"))

    def test_failure_cached_as_empty(self):
        def boom(ip):
            raise OSError("no PTR")

        p = hv.Ptr(enabled=False, resolver=boom)
        p.resolve_one("8.8.4.4")
        self.assertIsNone(p.name("8.8.4.4"))


class CtLinesTest(unittest.TestCase):
    PY = [sys.executable, "-I", "-c"]

    def test_streams_and_caps_lines(self):
        old = vd.LINES_MAX
        vd.LINES_MAX = 3
        try:
            lines = vd.CtLines(*self._popen("import sys\nfor i in range(100000): sys.stdout.write('l%d\\n' % i)"))
            got = list(lines)
            lines.close()
        finally:
            vd.LINES_MAX = old
        self.assertEqual(len(got), 3)
        self.assertTrue(lines.truncated)
        self.assertFalse(lines.failed)

    def test_failed_command_is_no_source(self):
        lines = vd.CtLines(*self._popen("import sys; sys.exit(1)"))
        self.assertEqual(list(lines), [])
        lines.close()
        self.assertTrue(lines.failed)

    def test_timeout_marks_truncated(self):
        lines = vd.CtLines(*self._popen("import sys, time\nprint('a', flush=True)\ntime.sleep(30)"), timeout=0.3)
        got = list(lines)
        lines.close()
        self.assertEqual(got, ["a\n"])
        self.assertTrue(lines.truncated)
        self.assertFalse(lines.failed)

    def _popen(self, code):
        proc = subprocess.Popen(self.PY + [code], stdout=subprocess.PIPE, stdin=subprocess.DEVNULL, encoding="ascii")
        return proc.stdout, proc


if __name__ == "__main__":
    unittest.main()
