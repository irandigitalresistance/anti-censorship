"""dpi_socks_proxy.py — Iran-side DPI-bypass SOCKS5 proxy.

Listens on a random local port. For every browser CONNECT request, opens
a fresh upstream connection through `--upstream-socks` (the operator's
existing tunnel into Iran), then tries each DPI-bypass mutation in
order. The first one that produces a real ServerHello (a complete TLS
handshake) is used to bridge bytes.

Mutations are applied as *transformations on the browser's own
ClientHello bytes*, so the GREASE pattern, cipher list, ALPN, and
session ticket the browser sent are preserved — that's necessary for
the downstream TLS server to actually accept the handshake (which is
the difference between a probe-bypass and a useable proxy).

Mutation list (chosen by an empirical sweep against Shatel, April 2026
— see client/probe_via_socks.py):
  M1 preconnect_null_byte             — \\x00 + browser's CH
  M2 decoy_then_real                  — clean-SNI decoy CH + browser's CH
  M3 preconnect+split_byte1           — \\x00 + browser_ch[:1] + browser_ch[1:]
  M4 preconnect+two_records           — \\x00 + record-layer split
  M5 fake_clean_then_real_with_split  — decoy + first byte + rest of browser CH

Each new TCP connection re-tries from M1; if a mutation worked for a
given (target_host, target_port) within the last hour, that one is
tried first.

PyInstaller-friendly: zero external imports, only stdlib. Runs as a
single-file .exe.

Usage:
    python dpi_socks_proxy.py --upstream-socks 127.0.0.1:1081
"""
from __future__ import annotations

import argparse
import os
import random
import socket
import struct
import sys
import threading
import time
from collections import OrderedDict


# ---------------------------------------------------------------------------
# Decoy ClientHello — used by mutations that need a "clean" first record
# ---------------------------------------------------------------------------

def _u8(v):  return bytes([v])
def _u16(v): return struct.pack(">H", v)
def _u24(v): return struct.pack(">I", v)[1:]
def _p1(b):  return _u8(len(b)) + b
def _p2(b):  return _u16(len(b)) + b
def _p3(b):  return _u24(len(b)) + b


def _build_decoy_clienthello(sni: str = "www.google.com") -> bytes:
    """Construct a syntactically-valid ClientHello with the given SNI.
    Used as a decoy first-record: the DPI inspects only the FIRST CH
    on a flow, so a clean decoy convinces it the flow is for `sni`,
    after which we send the browser's real CH and the server (which
    the browser actually wants to talk to) reads only the second one.
    Note: this is only useful for some servers — many TLS stacks
    error out after the first CH. It's a fallback, not the primary
    mutation."""
    body = _u16(0x0303) + os.urandom(32)
    body += _p1(b"")
    body += _p2(_u16(0x1301) + _u16(0x1303) + _u16(0x1302))
    body += _u8(1) + _u8(0)
    name_b = sni.encode("ascii")
    sni_ext = _u16(0x0000) + _p2(_p2(_u8(0) + _p2(name_b)))
    sv_ext  = _u16(0x002b) + _p2(_p1(_u16(0x0304)))
    sg_ext  = _u16(0x000a) + _p2(_p2(_u16(0x001d) + _u16(0x0017)))
    ks_ext  = _u16(0x0033) + _p2(_p2(_u16(0x001d) + _p2(os.urandom(32))))
    sa_ext  = _u16(0x000d) + _p2(_p2(_u16(0x0804) + _u16(0x0403) + _u16(0x0401)))
    exts = sni_ext + sv_ext + sg_ext + ks_ext + sa_ext
    body += _p2(exts)
    handshake = _u8(0x01) + _p3(body)
    return _u8(0x16) + _u16(0x0301) + _p2(handshake)


def _split_into_two_records(record: bytes) -> bytes:
    """Take one TLS record `\\x16\\x03\\x01<len><body>` and emit the
    same handshake split across TWO TLS records sharing one TCP segment.
    Defeats DPIs that inspect only the first record."""
    if len(record) < 5 or record[0] != 0x16:
        return record
    inner = record[5:]
    cut = 20 if len(inner) > 40 else len(inner) // 2
    rec1 = _u8(0x16) + _u16(0x0301) + _p2(inner[:cut])
    rec2 = _u8(0x16) + _u16(0x0301) + _p2(inner[cut:])
    return rec1 + rec2


# ---------------------------------------------------------------------------
# Mutation = a transformation on the browser's first record
# ---------------------------------------------------------------------------

class Mutation:
    """A mutation is a way to send the browser's first TLS record
    onto an open upstream socket so that the DPI doesn't see (or
    misclassifies) the SNI inside it."""

    def __init__(self, name: str, fn) -> None:
        self.name = name
        self.fn = fn

    def send(self, upstream: socket.socket, browser_first_record: bytes) -> None:
        """Apply this mutation's send schedule to the upstream socket."""
        self.fn(upstream, browser_first_record)


def _send_chunks(s: socket.socket, chunks: list[bytes],
                 pre_null: bool = False, delay_ms: int = 0) -> None:
    if pre_null:
        s.sendall(b"\x00")
        time.sleep(0.005)
    for i, c in enumerate(chunks):
        s.sendall(c)
        if delay_ms and i < len(chunks) - 1:
            time.sleep(delay_ms / 1000.0)


def _mut_preconnect_null(s, ch):
    """\\x00 + browser's CH. Cheapest Shatel bypass."""
    _send_chunks(s, [ch], pre_null=True)


def _mut_decoy_then_real(s, ch):
    """Decoy clean-SNI CH, then the browser's real CH."""
    _send_chunks(s, [_build_decoy_clienthello("www.google.com"), ch],
                 delay_ms=10)


def _mut_preconnect_split(s, ch):
    """\\x00 + 1-byte + rest. SpoofDPI null + TCP fragmentation."""
    _send_chunks(s, [ch[:1], ch[1:]], pre_null=True)


def _mut_preconnect_two_records(s, ch):
    """\\x00 + browser's CH split into two TLS records (one TCP send)."""
    _send_chunks(s, [_split_into_two_records(ch)], pre_null=True)


def _mut_decoy_then_real_split(s, ch):
    """Decoy CH, then split browser's CH at byte 1."""
    decoy = _build_decoy_clienthello("www.google.com")
    _send_chunks(s, [decoy, ch[:1], ch[1:]], delay_ms=10)


def _mut_decoy_pq_then_real(s, ch):
    """Decoy with PQ supported_groups, then browser's CH. Some MCI DPI
    generations passed PQ-decorated flows because they had no JA3
    fingerprint database for X25519MLKEM768."""
    body = _u16(0x0303) + os.urandom(32)
    body += _p1(b"")
    body += _p2(_u16(0x1301) + _u16(0x1303))
    body += _u8(1) + _u8(0)
    name = b"www.google.com"
    sni_ext = _u16(0x0000) + _p2(_p2(_u8(0) + _p2(name)))
    sv_ext  = _u16(0x002b) + _p2(_p1(_u16(0x0304)))
    sg_ext  = _u16(0x000a) + _p2(_p2(_u16(0x11ec) + _u16(0x001d)))
    ks_ext  = _u16(0x0033) + _p2(_p2(_u16(0x001d) + _p2(os.urandom(32))))
    sa_ext  = _u16(0x000d) + _p2(_p2(_u16(0x0804) + _u16(0x0403)))
    exts = sni_ext + sv_ext + sg_ext + ks_ext + sa_ext
    body += _p2(exts)
    hs = _u8(0x01) + _p3(body)
    decoy = _u8(0x16) + _u16(0x0301) + _p2(hs)
    _send_chunks(s, [decoy, ch], delay_ms=5)


def _mut_passthrough(s, ch):
    """No transformation. Used for targets where mutations aren't
    necessary (Iranian domestic sites, whitelisted SNIs)."""
    _send_chunks(s, [ch])


def _mut_split_inside_sni(s, ch):
    """Split the browser CH at the byte where the SNI hostname starts,
    so the DPI sees the record header but not the SNI. The server
    reassembles. Real Shatel currently RSTs this; included for
    completeness on other ISPs."""
    # Find a printable-ASCII run of >=8 letters/dots — heuristic for
    # the SNI hostname. If we can't find one, fall back to half-split.
    best_off = len(ch) // 2
    run = 0; run_start = -1
    for i, b in enumerate(ch):
        is_host_char = (0x61 <= b <= 0x7a) or (0x41 <= b <= 0x5a) or (b in (0x2e, 0x2d)) or (0x30 <= b <= 0x39)
        if is_host_char:
            if run == 0: run_start = i
            run += 1
            if run >= 8:
                best_off = run_start + run // 2
                break
        else:
            run = 0
    _send_chunks(s, [ch[:best_off], ch[best_off:]])


def _mut_split_with_jitter(s, ch):
    """5-piece TCP fragmentation with 50-200ms jitter between sends.
    Real Shatel's DPI buffers TCP segments only briefly; if we
    space them out, the buffer flushes and the SNI never aligns in
    one inspection window."""
    n = max(2, min(5, len(ch) // 4))
    chunk = max(1, len(ch) // n)
    pieces = [ch[i:i + chunk] for i in range(0, len(ch), chunk) if ch[i:i + chunk]]
    delay = 50 + random.randint(0, 150)
    _send_chunks(s, pieces, delay_ms=delay)


def _mut_tls_record_split(s, ch):
    """Reframe browser's CH into TWO TLS records sharing one TCP
    segment. Server reassembles handshake fragments; some DPI
    generations only inspect first record's content."""
    _send_chunks(s, [_split_into_two_records(ch)])


def _mut_tls_record_split_jitter(s, ch):
    """TLS record split + each record on its own TCP segment with 80ms
    jitter. Beats DPIs that only inspect first record AND first TCP
    segment in tandem."""
    rec = _split_into_two_records(ch)
    if len(rec) > 25:
        _send_chunks(s, [rec[:25], rec[25:]], delay_ms=80)
    else:
        _send_chunks(s, [rec])


MUTATIONS = [
    # In approximate order of cheapest-and-most-likely-to-work-on-Shatel
    # first. The proxy tries each in order; once one wins for a
    # (host, port) key, that one is tried first next time.
    Mutation("preconnect_null_byte",       _mut_preconnect_null),
    Mutation("passthrough",                _mut_passthrough),
    Mutation("preconnect+split_byte1",     _mut_preconnect_split),
    Mutation("preconnect+two_records",     _mut_preconnect_two_records),
    Mutation("split_with_jitter",          _mut_split_with_jitter),
    Mutation("split_inside_sni",           _mut_split_inside_sni),
    Mutation("tls_record_split",           _mut_tls_record_split),
    Mutation("tls_record_split+jitter",    _mut_tls_record_split_jitter),
    Mutation("decoy_then_real",            _mut_decoy_then_real),
    Mutation("decoy_then_real+split",      _mut_decoy_then_real_split),
    Mutation("decoy_pq+real",              _mut_decoy_pq_then_real),
]


# ---------------------------------------------------------------------------
# SOCKS5 helpers
# ---------------------------------------------------------------------------

def _read_n(s: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        c = s.recv(n - len(buf))
        if not c: raise ConnectionError("socks5 short read")
        buf += c
    return buf


def upstream_open(uh: str, up: int, th: str, tp: int,
                  timeout: float = 10.0) -> socket.socket:
    """Open a CONNECT-tunneled TCP socket via the upstream SOCKS5.
    `th` is passed as a *hostname* (atyp=3) when not an IPv4 literal.
    Empirically, the user's tunnel into Shatel only accepts atyp=3
    hostname mode — atyp=1 IP mode times out at the SOCKS5 server,
    even for known-good IPs like 8.8.8.8. The upstream does its own
    DNS resolution that bypasses Iran's bogon injection (probably DoH
    or hardcoded entries inside the tunnel)."""
    s = socket.socket(); s.settimeout(timeout)
    s.connect((uh, up))
    s.sendall(b"\x05\x01\x00")
    if s.recv(2) != b"\x05\x00":
        s.close(); raise ConnectionError("upstream greeting failed")
    try:
        addr_v4 = socket.inet_aton(th)
        atyp = b"\x01"
        addr_bytes = addr_v4
    except OSError:
        atyp = b"\x03"
        h = th.encode("ascii")
        addr_bytes = bytes([len(h)]) + h
    s.sendall(b"\x05\x01\x00" + atyp + addr_bytes + struct.pack(">H", tp))
    hdr = _read_n(s, 4)
    if hdr[0] != 0x05 or hdr[1] != 0x00:
        s.close(); raise ConnectionError(f"upstream rejected: rep={hdr[1]}")
    if   hdr[3] == 0x01: _read_n(s, 4)
    elif hdr[3] == 0x03: _read_n(s, _read_n(s, 1)[0])
    elif hdr[3] == 0x04: _read_n(s, 16)
    _read_n(s, 2)
    return s


# ---------------------------------------------------------------------------
# Per-target mutation cache — once a mutation works for a target, we
# try it first next time. Bounded LRU.
# ---------------------------------------------------------------------------

class _MutationCache:
    def __init__(self, max_size: int = 1024) -> None:
        self._d: "OrderedDict[tuple[str,int], str]" = OrderedDict()
        self._max = max_size
        self._lock = threading.Lock()

    def get(self, key: tuple[str, int]) -> str | None:
        with self._lock:
            if key in self._d:
                self._d.move_to_end(key)
                return self._d[key]
            return None

    def set(self, key: tuple[str, int], mut_name: str) -> None:
        with self._lock:
            self._d[key] = mut_name
            self._d.move_to_end(key)
            while len(self._d) > self._max:
                self._d.popitem(last=False)


_CACHE = _MutationCache()


# ---------------------------------------------------------------------------
# Client-facing SOCKS5 listener
# ---------------------------------------------------------------------------

def _socks5_negotiate(client: socket.socket) -> tuple[str, int]:
    ver_n = _read_n(client, 2)
    if ver_n[0] != 0x05:
        raise ConnectionError("not socks5")
    _read_n(client, ver_n[1])
    client.sendall(b"\x05\x00")
    hdr = _read_n(client, 4)
    if hdr[0] != 0x05 or hdr[1] != 0x01:
        client.sendall(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
        raise ConnectionError(f"unsupported cmd {hdr[1]}")
    atyp = hdr[3]
    if atyp == 0x01:
        host = socket.inet_ntoa(_read_n(client, 4))
    elif atyp == 0x03:
        host = _read_n(client, _read_n(client, 1)[0]).decode("ascii")
    else:
        client.sendall(b"\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00")
        raise ConnectionError(f"bad atyp {atyp}")
    port = struct.unpack(">H", _read_n(client, 2))[0]
    return host, port


def _is_tls_handshake(buf: bytes) -> bool:
    return len(buf) >= 5 and buf[0] == 0x16 and buf[1] == 0x03


def _read_first_record(client: socket.socket, timeout: float = 2.0) -> bytes:
    """Read enough from the client to capture the full first TLS record
    (or whatever is sent if it isn't TLS)."""
    client.settimeout(timeout)
    buf = b""
    try:
        while True:
            c = client.recv(8192)
            if not c: break
            buf += c
            if _is_tls_handshake(buf):
                if len(buf) >= 5:
                    rec_len = (buf[3] << 8) | buf[4]
                    if len(buf) >= 5 + rec_len:
                        break
            else:
                break  # non-TLS — stop reading
    except socket.timeout:
        pass
    finally:
        client.settimeout(None)
    return buf


def _try_one_mutation(uh: str, up_: int, th: str, tp: int,
                      browser_first: bytes, mut: Mutation,
                      first_byte_timeout: float) -> tuple[socket.socket | None, bytes]:
    """Open a fresh upstream tunnel, apply mutation, wait briefly for
    the first server byte. If the first byte looks like a TLS record
    (0x14..0x17), the mutation worked: return (socket, prefetched_data).
    Otherwise close and return (None, b"").

    `th` is expected to be an IPv4 literal already (resolved by the
    caller using the *local* operator-side DNS, so no Iran-bogon
    interference)."""
    try:
        upstream = upstream_open(uh, up_, th, tp)
    except Exception:
        return None, b""
    try:
        mut.send(upstream, browser_first)
    except Exception:
        try: upstream.close()
        except Exception: pass
        return None, b""
    upstream.settimeout(first_byte_timeout)
    try:
        first = upstream.recv(8192)
    except (socket.timeout, ConnectionResetError, OSError):
        try: upstream.close()
        except Exception: pass
        return None, b""
    upstream.settimeout(None)
    if not first:
        try: upstream.close()
        except Exception: pass
        return None, b""
    # We want a real TLS record back — the server's ServerHello (0x16)
    # is the canonical success. Some servers send Alert (0x15) for SNI
    # mismatch; that means the mutation fooled DPI but the cert isn't
    # for our SNI — count as failure for connectivity purposes.
    if first[0] == 0x16:
        return upstream, first
    try: upstream.close()
    except Exception: pass
    return None, b""


def _handle_client(client: socket.socket, uh: str, up_: int,
                   per_attempt_timeout: float, log_fn) -> None:
    try:
        host, port = _socks5_negotiate(client)
    except Exception as e:
        log_fn(f"  socks5 fail: {e}"); client.close(); return

    try:
        client.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00" +
                       struct.pack(">H", port))
    except Exception:
        client.close(); return

    browser_first = _read_first_record(client)
    if not browser_first:
        client.close(); return

    # If it's not TLS, just bridge through with a passthrough mutation.
    if not _is_tls_handshake(browser_first):
        try:
            upstream = upstream_open(uh, up_, host, port)
            upstream.sendall(browser_first)
        except Exception as e:
            log_fn(f"  non-TLS upstream fail: {e}"); client.close(); return
        _bridge(client, upstream)
        return

    # Choose mutation order: cached winner first, then default order.
    key = (host, port)
    cached = _CACHE.get(key)
    order = list(MUTATIONS)
    if cached:
        order.sort(key=lambda m: 0 if m.name == cached else 1)

    upstream = None; first_data = b""
    chosen = None
    for mut in order:
        upstream, first_data = _try_one_mutation(uh, up_, host, port,
                                                 browser_first, mut,
                                                 per_attempt_timeout)
        if upstream is not None:
            chosen = mut.name
            break
    if upstream is None:
        log_fn(f"  CONNECT {host}:{port}  ALL MUTATIONS FAILED")
        client.close(); return

    _CACHE.set(key, chosen)
    log_fn(f"  CONNECT {host}:{port}  mutation={chosen}  "
           f"first_byte={first_data[0]:02x}  ({len(first_data)}B prefetched)")

    # Send the prefetched first server record back to the browser, then
    # bridge bytes both ways from now on.
    try:
        client.sendall(first_data)
    except Exception:
        upstream.close(); client.close(); return
    _bridge(client, upstream)


def _bridge(client: socket.socket, upstream: socket.socket) -> None:
    def pipe(src, dst):
        try:
            while True:
                b = src.recv(8192)
                if not b: break
                dst.sendall(b)
        except Exception:
            pass
        finally:
            try: dst.shutdown(socket.SHUT_WR)
            except Exception: pass
    t1 = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
    t2 = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
    t1.start(); t2.start(); t1.join(); t2.join()
    try: client.close()
    except Exception: pass
    try: upstream.close()
    except Exception: pass


def serve(lh: str, lp: int, uh: str, up_: int,
          per_attempt_timeout: float, log_fn) -> None:
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((lh, lp))
    srv.listen(64)
    actual_port = srv.getsockname()[1]
    log_fn(f"[dpi-socks-proxy] listening on {lh}:{actual_port}")
    log_fn(f"[dpi-socks-proxy] upstream socks5 = {uh}:{up_}")
    log_fn(f"[dpi-socks-proxy] mutations (in fallback order):")
    for i, m in enumerate(MUTATIONS):
        log_fn(f"                     {i+1}. {m.name}")
    log_fn("")
    log_fn(f"  >>> Configure your browser SOCKS5 to {lh}:{actual_port} <<<")
    log_fn("")
    while True:
        client, _ = srv.accept()
        threading.Thread(target=_handle_client,
                         args=(client, uh, up_, per_attempt_timeout, log_fn),
                         daemon=True).start()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--upstream-socks", default="127.0.0.1:1081",
                    help="SOCKS5 endpoint that egresses inside Iran "
                         "(default: 127.0.0.1:1081)")
    ap.add_argument("--listen", default="127.0.0.1:0",
                    help="Listen addr; port 0 = random (default: 127.0.0.1:0)")
    ap.add_argument("--per-attempt-timeout", type=float, default=6.0,
                    help="Wait this many seconds for the first server "
                         "byte before declaring a mutation a failure. "
                         "On slow tunnels (Shatel-via-1081) you need 5+ s; "
                         "default 6.0s.")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    uh, up = args.upstream_socks.split(":")
    lh, lp = args.listen.split(":")
    log = (lambda _msg: None) if args.quiet else (lambda msg: print(msg, flush=True))
    try:
        serve(lh, int(lp), uh, int(up), args.per_attempt_timeout, log)
    except KeyboardInterrupt:
        log("[dpi-socks-proxy] stopping")


if __name__ == "__main__":
    main()
