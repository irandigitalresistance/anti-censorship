"""client/probe_via_socks.py — run the mutation catalog through a SOCKS5
proxy and report which mutations bypass DPI.

Use case: operator has a SOCKS5 endpoint that lands inside Iran (e.g.
a tunnel into Shatel). Probe each mutation against a known-blocked
SNI (default: www.twitter.com) by routing the bytes through that
SOCKS5. For each mutation we print the verdict — server_hello /
tls_alert / rst / timeout — exactly the same vocabulary as
dpi_fuzzer.py.

Output is JSON; pipe through jq for human reading.
"""
from __future__ import annotations

import argparse
import json
import socket
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from rlagent.envs import mutations


VERDICT_NAMES = ["server_hello", "tls_alert", "rst", "timeout", "error"]


def socks5_open(socks_host: str, socks_port: int,
                target_host: str, target_port: int,
                timeout: float = 8.0) -> socket.socket:
    """Open a TCP socket via SOCKS5 to (target_host, target_port).
    target_host can be a hostname (ATYP=3) or an IPv4 dotted-quad.
    Returns the connected socket positioned right at the application
    layer (so anything we sendall() goes out the SOCKS5 tunnel)."""
    s = socket.socket()
    s.settimeout(timeout)
    s.connect((socks_host, socks_port))
    # Greeting
    s.sendall(b"\x05\x01\x00")
    r = s.recv(2)
    if r != b"\x05\x00":
        s.close()
        raise ConnectionError(f"socks5 greeting failed: {r.hex()}")

    # Build CONNECT request
    try:
        socket.inet_aton(target_host)
        atyp = b"\x01"
        addr = socket.inet_aton(target_host)
    except OSError:
        atyp = b"\x03"
        h = target_host.encode("ascii")
        addr = bytes([len(h)]) + h
    req = b"\x05\x01\x00" + atyp + addr + struct.pack(">H", target_port)
    s.sendall(req)
    # Reply: VER(1) REP(1) RSV(1) ATYP(1) BND.ADDR(var) BND.PORT(2)
    hdr = s.recv(4)
    if len(hdr) < 4 or hdr[0] != 0x05:
        s.close()
        raise ConnectionError(f"socks5 reply too short / bad version: {hdr.hex()}")
    if hdr[1] != 0x00:
        # Error code
        codes = {1: "general_failure", 2: "not_allowed", 3: "net_unreachable",
                 4: "host_unreachable", 5: "conn_refused", 6: "ttl_expired",
                 7: "cmd_not_supported", 8: "atyp_not_supported"}
        s.close()
        raise ConnectionError(f"socks5 connect failed: {codes.get(hdr[1], hdr[1])}")
    bnd_atyp = hdr[3]
    if bnd_atyp == 0x01: s.recv(4)
    elif bnd_atyp == 0x03: n = s.recv(1)[0]; s.recv(n)
    elif bnd_atyp == 0x04: s.recv(16)
    s.recv(2)   # bnd_port
    return s


def run_plan_via_socks(plan: mutations.Plan, target_host: str, target_port: int,
                       socks_host: str, socks_port: int,
                       timeout: float = 6.0) -> tuple[int, float]:
    """Open SOCKS5 → target, transmit the plan, observe the verdict."""
    t0 = time.time()
    try:
        s = socks5_open(socks_host, socks_port, target_host, target_port, timeout)
    except Exception:
        return 4, (time.time() - t0) * 1000.0  # ERROR
    try:
        if plan.pre_connect_byte:
            s.sendall(b"\x00")
            time.sleep(0.005)
        for i, c in enumerate(plan.chunks):
            s.sendall(c)
            if plan.delay_between_ms and i < len(plan.chunks) - 1:
                time.sleep(plan.delay_between_ms / 1000.0)
        data = b""
        deadline = time.time() + timeout
        while time.time() < deadline and len(data) < 64:
            try:
                s.settimeout(max(0.1, deadline - time.time()))
                chunk = s.recv(4096)
            except socket.timeout:
                break
            except ConnectionResetError:
                return 2, (time.time() - t0) * 1000.0
            if not chunk: break
            data += chunk
        ms = (time.time() - t0) * 1000.0
        if not data:
            # SOCKS5 servers usually convert upstream RST into a clean
            # close (FIN), so we get no data and no exception. Use the
            # elapsed time to disambiguate: fast EOF = DPI RST,
            # late EOF = real timeout.
            if ms < 2500:
                return 2, ms      # rst (fast empty close)
            return 3, ms          # timeout
        if data[0] == 0x16:
            return 0, ms      # server_hello
        if data[0] == 0x15:
            return 1, ms      # tls_alert
        return 3, ms          # treat unknown as timeout-like
    except ConnectionResetError:
        return 2, (time.time() - t0) * 1000.0
    except Exception:
        return 4, (time.time() - t0) * 1000.0
    finally:
        try: s.close()
        except Exception: pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--socks", default="127.0.0.1:1081")
    ap.add_argument("--target", default="1.1.1.1:443",
                    help="Target host:port (default 1.1.1.1:443 — neutral TLS)")
    ap.add_argument("--blocked-sni", default="www.twitter.com")
    ap.add_argument("--clean-sni", default="www.google.com")
    ap.add_argument("--repeat", type=int, default=1,
                    help="Repeat each mutation N times for stability")
    ap.add_argument("--timeout", type=float, default=6.0)
    ap.add_argument("--out", default=None,
                    help="Write JSON to this file in addition to stdout")
    ap.add_argument("--only", default=None,
                    help="Comma-separated mutation names to test (default: all)")
    args = ap.parse_args()

    sh, sp = args.socks.split(":")
    th, tp = args.target.split(":")
    socks_host, socks_port = sh, int(sp)
    target_host, target_port = th, int(tp)
    only = set(args.only.split(",")) if args.only else None

    print(f"[probe] socks={args.socks} target={args.target} "
          f"blocked={args.blocked_sni} clean={args.clean_sni}")

    catalog_names = mutations.names()
    results = []

    for action_id in range(mutations.N_ACTIONS):
        # Build plan with the BLOCKED sni
        plan = mutations.get(action_id, args.blocked_sni)
        if only and plan.name not in only and str(action_id) not in only:
            continue
        verdicts = []; mss = []
        for _ in range(args.repeat):
            v, ms = run_plan_via_socks(plan, target_host, target_port,
                                       socks_host, socks_port, args.timeout)
            verdicts.append(v); mss.append(ms)
            time.sleep(0.1)
        # Majority verdict
        from collections import Counter
        majority = Counter(verdicts).most_common(1)[0][0]
        avg_ms = sum(mss) / len(mss)
        bypassed = majority in (0, 1)
        results.append({
            "action_id": action_id,
            "name": plan.name,
            "cost": plan.cost,
            "verdict": VERDICT_NAMES[majority],
            "avg_ms": round(avg_ms, 1),
            "verdicts": [VERDICT_NAMES[v] for v in verdicts],
            "bypassed": bypassed,
        })
        marker = "OK " if bypassed else "X  "
        print(f"  {marker} {action_id:2d}: {plan.name:35s} "
              f"{VERDICT_NAMES[majority]:13s} {avg_ms:5.0f}ms  "
              f"cost={plan.cost:.2f}")

    print()
    bypasses = [r for r in results if r["bypassed"]]
    print(f"=== summary: {len(bypasses)}/{len(results)} bypassed ===")
    if bypasses:
        # Cheapest winner
        bypasses.sort(key=lambda r: (r["cost"], r["avg_ms"]))
        print()
        print("Cheapest bypassing mutations (lowest cost first):")
        for r in bypasses[:8]:
            print(f"  action {r['action_id']:2d}: {r['name']:35s} "
                  f"cost={r['cost']:.2f}  ms={r['avg_ms']:.0f}")

    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
