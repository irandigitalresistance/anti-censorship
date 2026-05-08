#!/usr/bin/env python3
"""client/reverse_engineer.py — characterise the live Iranian DPI by
sending precisely-controlled probes through the local SOCKS5 tunnel.

We treat the DPI as a black box and infer:
  1) Reassembly window: maximum inter-segment delay tolerated before
     the matcher gives up on reassembling. Probed by splitting a
     blocked SNI's ClientHello at the SNI bytes and varying the gap.
  2) Buffer depth: how many bytes the matcher reads before falling
     back to "no SNI seen". Probed by prepending N bytes of padding
     extension before the SNI is reachable.
  3) Case sensitivity: probed by emitting variants of the blocked SNI
     in upper/mixed/title case.
  4) Length-field tolerance: probed by perturbing the SNI extension's
     outer length field by +/-1.
  5) Duplicate SNI: probed by emitting two SNI extensions (first
     blocked, second clean) and (first clean, second blocked).
  6) Racing budget: probed by sending the blocked SNI and the
     server's known-good ClientHello back-to-back with varying gap;
     the gap above which the DPI's RST loses the race is the budget.
  7) IP-level filtering: probed by sending a CLEAN ClientHello to
     known blocked-service IPs and observing whether they reach.

Each probe is repeated N times to manage tunnel jitter.

The output is JSON consumed by env/dpi/profiles.yaml's
`shatel_v2_real` profile generator.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import socket
import struct
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


# ---------- minimal CH builder ----------

def _u8(v):  return bytes([v])
def _u16(v): return struct.pack(">H", v)
def _u24(v): return struct.pack(">I", v)[1:]
def _p1(b):  return _u8(len(b)) + b
def _p2(b):  return _u16(len(b)) + b
def _p3(b):  return _u24(len(b)) + b


def build_ch(sni: str, *, dup_sni: tuple[str, ...] = (),
             padding_bytes: int = 0,
             length_fudge: int = 0) -> bytes:
    body = _u16(0x0303) + os.urandom(32)
    body += _p1(b"")
    body += _p2(_u16(0x1301) + _u16(0x1303) + _u16(0x1302))
    body += _u8(1) + _u8(0)

    def sni_ext(name: str, fudge: int = 0) -> bytes:
        n = name.encode("ascii")
        inner = _p2(_u8(0) + _p2(n))
        if fudge:
            return _u16(0x0000) + _u16(len(inner) + fudge) + inner
        return _u16(0x0000) + _p2(inner)

    sv  = _u16(0x002b) + _p2(_p1(_u16(0x0304)))
    sg  = _u16(0x000a) + _p2(_p2(_u16(0x001d) + _u16(0x0017)))
    ks  = _u16(0x0033) + _p2(_p2(_u16(0x001d) + _p2(os.urandom(32))))
    sa  = _u16(0x000d) + _p2(_p2(_u16(0x0804) + _u16(0x0403) + _u16(0x0401)))
    pad = (_u16(0x0015) + _p2(b"\x00" * padding_bytes)) if padding_bytes else b""

    exts  = sni_ext(sni, length_fudge)
    for d in dup_sni:
        exts += sni_ext(d)
    exts += sv + sg + ks + sa + pad
    body += _p2(exts)
    handshake = _u8(0x01) + _p3(body)
    return _u8(0x16) + _u16(0x0301) + _p2(handshake)


# ---------- SOCKS5 + send-with-schedule ----------

def socks5(host: str, port: int, target: str, target_port: int,
           timeout: float = 8.0) -> socket.socket:
    s = socket.socket(); s.settimeout(timeout)
    s.connect((host, port))
    s.sendall(b"\x05\x01\x00")
    if s.recv(2) != b"\x05\x00":
        s.close(); raise ConnectionError("greet")
    try:
        socket.inet_aton(target); atyp = b"\x01"
        addr = socket.inet_aton(target)
    except OSError:
        atyp = b"\x03"; h = target.encode(); addr = bytes([len(h)]) + h
    s.sendall(b"\x05\x01\x00" + atyp + addr + struct.pack(">H", target_port))
    hdr = s.recv(4)
    if hdr[0] != 0x05 or hdr[1] != 0x00:
        s.close(); raise ConnectionError(f"connect rep={hdr[1]}")
    if   hdr[3] == 0x01: s.recv(4)
    elif hdr[3] == 0x03: s.recv(s.recv(1)[0])
    elif hdr[3] == 0x04: s.recv(16)
    s.recv(2)
    return s


def send_and_observe(s: socket.socket, chunks: list[bytes],
                     delay_between_ms: int = 0,
                     pre_byte: bytes | None = None,
                     timeout: float = 6.0) -> tuple[str, float, int]:
    """Send the chunks, observe the verdict.
    Returns (verdict, elapsed_ms, recv_bytes)."""
    t0 = time.time()
    if pre_byte:
        s.sendall(pre_byte); time.sleep(0.005)
    for i, c in enumerate(chunks):
        s.sendall(c)
        if delay_between_ms and i < len(chunks) - 1:
            time.sleep(delay_between_ms / 1000.0)
    s.settimeout(timeout)
    try:
        data = s.recv(64)
    except (socket.timeout, ConnectionResetError):
        return "rst", (time.time() - t0) * 1000.0, 0
    ms = (time.time() - t0) * 1000.0
    if not data:
        return ("rst" if ms < 2500 else "timeout"), ms, 0
    if data[0] == 0x16: return "server_hello", ms, len(data)
    if data[0] == 0x15: return "tls_alert", ms, len(data)
    return "unknown", ms, len(data)


# ---------- experiments ----------

EXPERIMENTS = []   # registered probes


def experiment(name: str):
    def deco(fn):
        EXPERIMENTS.append((name, fn))
        return fn
    return deco


def median_verdict(verdicts: list[str]) -> str:
    return Counter(verdicts).most_common(1)[0][0]


def run_repeats(args, plan_fn, n: int = 5) -> dict:
    """Run plan_fn() n times and aggregate."""
    verdicts = []; mss = []
    for _ in range(n):
        try:
            s = socks5(args.socks_host, args.socks_port,
                       args.target_host, args.target_port)
        except Exception as e:
            verdicts.append("error"); mss.append(0.0); continue
        try:
            v, ms, _ = plan_fn(s)
        except Exception:
            v, ms = "error", 0.0
        verdicts.append(v); mss.append(ms)
        try: s.close()
        except Exception: pass
        time.sleep(0.2)
    return {"verdict": median_verdict(verdicts),
            "verdicts": verdicts,
            "median_ms": sorted(mss)[len(mss) // 2] if mss else 0.0}


# ----- Experiment 1: case sensitivity -----

@experiment("e1_case_sensitivity")
def e1(args, log):
    """Probe whether DPI is case-sensitive on the SNI hostname."""
    cases = {
        "lower":   args.blocked_sni,
        "upper":   args.blocked_sni.upper(),
        "title":   args.blocked_sni.title(),
        "mixed":   "".join(c.upper() if i%2 else c for i,c in enumerate(args.blocked_sni)),
    }
    out = {}
    for name, sni in cases.items():
        ch = build_ch(sni)
        r = run_repeats(args, lambda s: send_and_observe(s, [ch]))
        log(f"  case={name:6s} sni={sni!r:24s} -> {r['verdict']:14s} {r['median_ms']:.0f}ms")
        out[name] = r
    return out


# ----- Experiment 2: TCP segment reassembly window -----

@experiment("e2_tcp_reassembly_window")
def e2(args, log):
    """Split the CH at byte 1 with varying inter-segment delay; the
    delay above which the DPI gives up on reassembling is the
    reassembly buffer's TTL."""
    out = {}
    for ms in [0, 5, 20, 50, 100, 250, 500, 1000, 2000, 5000]:
        ch = build_ch(args.blocked_sni)
        chunks = [ch[:1], ch[1:]]
        r = run_repeats(args, lambda s, ms=ms: send_and_observe(s, chunks, delay_between_ms=ms))
        log(f"  inter-segment={ms:>5d}ms -> {r['verdict']:14s} {r['median_ms']:.0f}ms")
        out[ms] = r
    return out


# ----- Experiment 3: padding-buffer depth -----

@experiment("e3_buffer_depth")
def e3(args, log):
    """Prepend N zero-padding bytes via the padding extension; if the
    DPI buffer is < N, the SNI lies past the buffer and is invisible."""
    out = {}
    for n in [0, 256, 512, 1024, 1500, 2048, 3072, 4096, 6144, 8192, 12288, 16384]:
        ch = build_ch(args.blocked_sni, padding_bytes=n)
        r = run_repeats(args, lambda s: send_and_observe(s, [ch]))
        log(f"  pad={n:>6d}B  ch_total={len(ch):>6d}  -> "
            f"{r['verdict']:14s} {r['median_ms']:.0f}ms")
        out[n] = r
    return out


# ----- Experiment 4: SNI length-field tolerance -----

@experiment("e4_length_field")
def e4(args, log):
    """Perturb the outer SNI extension's length field by +/-N."""
    out = {}
    for delta in [-2, -1, 0, +1, +2]:
        ch = build_ch(args.blocked_sni, length_fudge=delta)
        r = run_repeats(args, lambda s: send_and_observe(s, [ch]))
        log(f"  length_fudge={delta:+d}  -> {r['verdict']:14s} {r['median_ms']:.0f}ms")
        out[delta] = r
    return out


# ----- Experiment 5: duplicate SNI -----

@experiment("e5_duplicate_sni")
def e5(args, log):
    """Two SNI extensions; vary which is first."""
    out = {}
    pairs = [
        ("blocked_first",  build_ch(args.blocked_sni, dup_sni=(args.clean_sni,))),
        ("clean_first",    build_ch(args.clean_sni,   dup_sni=(args.blocked_sni,))),
        ("two_blocked",    build_ch(args.blocked_sni, dup_sni=(args.blocked_sni,))),
        ("two_clean",      build_ch(args.clean_sni,   dup_sni=(args.clean_sni,))),
    ]
    for label, ch in pairs:
        r = run_repeats(args, lambda s, ch=ch: send_and_observe(s, [ch]))
        log(f"  variant={label:18s} -> {r['verdict']:14s} {r['median_ms']:.0f}ms")
        out[label] = r
    return out


# ----- Experiment 6: racing budget (delay before RST) -----

@experiment("e6_racing_budget")
def e6(args, log):
    """Measure the time-to-RST distribution. Send blocked CH, time
    until SOCKS5 closes."""
    ch = build_ch(args.blocked_sni)
    times = []
    for _ in range(20):
        try:
            s = socks5(args.socks_host, args.socks_port,
                       args.target_host, args.target_port)
            t0 = time.time()
            s.sendall(ch)
            s.settimeout(8.0)
            try: data = s.recv(64)
            except Exception: data = b""
            elapsed = (time.time() - t0) * 1000.0
            if not data and elapsed < 4000:
                times.append(elapsed)
            s.close()
        except Exception:
            pass
        time.sleep(0.3)
    times.sort()
    p50 = times[len(times)//2] if times else None
    p90 = times[int(len(times)*0.9)] if times else None
    log(f"  n={len(times)} samples  p50={p50}  p90={p90}  min={min(times) if times else None}")
    return {"samples": times, "p50_ms": p50, "p90_ms": p90}


# ----- Experiment 7: IP-level filtering -----

@experiment("e7_ip_level_block")
def e7(args, log):
    """Send a CLEAN ClientHello (SNI=cloudflare.com) to known blocked
    service hostnames. If the upstream SOCKS5 reaches them but TLS
    fails fast, IP-level filtering is in play."""
    ch_clean = build_ch("www.cloudflare.com")
    targets = ["twitter.com", "x.com", "www.facebook.com",
               "www.instagram.com", "web.telegram.org",
               "www.youtube.com", "www.google.com",
               "www.cloudflare.com"]
    out = {}
    for h in targets:
        verdicts = []
        for _ in range(3):
            try:
                s = socks5(args.socks_host, args.socks_port, h, 443)
                v, ms, _ = send_and_observe(s, [ch_clean])
                verdicts.append((v, ms))
                s.close()
            except Exception as e:
                verdicts.append(("err", 0))
            time.sleep(0.2)
        med_v = Counter(v for v, _ in verdicts).most_common(1)[0][0]
        med_ms = sorted([m for _, m in verdicts])[1]
        log(f"  {h:25s} clean-SNI -> {med_v:14s} {med_ms:.0f}ms")
        out[h] = {"verdict": med_v, "ms": med_ms, "raw": verdicts}
    return out


# ----- Experiment 8: when does re-classification happen? -----

@experiment("e8_re_classification")
def e8(args, log):
    """First record clean, then record after handshake-data with
    blocked SNI. Does the DPI re-inspect the second record?"""
    out = {}
    # Variant 1: two records, both well-formed, second has blocked
    ch_clean   = build_ch(args.clean_sni)
    ch_blocked = build_ch(args.blocked_sni)
    out["clean_then_blocked_separate_tcp"] = run_repeats(args,
        lambda s: send_and_observe(s, [ch_clean, ch_blocked], delay_between_ms=50))
    out["blocked_then_clean_separate_tcp"] = run_repeats(args,
        lambda s: send_and_observe(s, [ch_blocked, ch_clean], delay_between_ms=50))
    out["clean_then_blocked_one_tcp"] = run_repeats(args,
        lambda s: send_and_observe(s, [ch_clean + ch_blocked]))
    log(f"  clean->blocked (separate TCP):  {out['clean_then_blocked_separate_tcp']['verdict']}")
    log(f"  blocked->clean (separate TCP):  {out['blocked_then_clean_separate_tcp']['verdict']}")
    log(f"  clean->blocked (one TCP send):  {out['clean_then_blocked_one_tcp']['verdict']}")
    return out


# ---------- main ----------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--socks", default="127.0.0.1:1081")
    ap.add_argument("--target", default="www.google.com:443",
                    help="Foreign target host:port (must traverse DPI). "
                         "Default www.google.com:443.")
    ap.add_argument("--blocked-sni", default="www.twitter.com")
    ap.add_argument("--clean-sni",   default="www.google.com")
    ap.add_argument("--out", default="/tmp/dpi_re.json")
    ap.add_argument("--only", default=None,
                    help="Comma-separated experiment names to run")
    args = ap.parse_args()
    sh, sp = args.socks.split(":")
    th, tp = args.target.split(":")
    args.socks_host = sh; args.socks_port = int(sp)
    args.target_host = th; args.target_port = int(tp)

    only = set(args.only.split(",")) if args.only else None
    results: dict = {"target": args.target,
                     "blocked_sni": args.blocked_sni,
                     "clean_sni":   args.clean_sni,
                     "ts":          time.time(),
                     "experiments": {}}
    for name, fn in EXPERIMENTS:
        if only and name not in only and not any(name.startswith(o) for o in only):
            continue
        print(f"\n=== {name} ===")
        try:
            results["experiments"][name] = fn(args,
                                              lambda msg: print(msg, flush=True))
        except Exception as e:
            print(f"  experiment {name} crashed: {e}")
            results["experiments"][name] = {"error": str(e)}

    Path(args.out).write_text(json.dumps(results, indent=2, default=str))
    print(f"\n[reverse_engineer] results -> {args.out}")


if __name__ == "__main__":
    main()
