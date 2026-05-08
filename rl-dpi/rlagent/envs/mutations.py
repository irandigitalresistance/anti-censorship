"""rlagent/envs/mutations.py

The 50-action mutation catalogue. The first 28 entries are seeded directly
from D:\\censorship-details\\dpi_fuzzer.py (`make_mutations()`); the
remaining ~22 are *chained* mutations that compose two primitives — these
chains are what the Geneva paper (Bock 2019, CCS) found to be the
operationally interesting class against stateless DPIs.

Each mutation is a function `(blocked_sni, target_ip, target_port) -> Plan`,
where Plan is a small dataclass describing how to transmit the bytes:
the chunks, the inter-chunk delays, and an optional pre-connect byte.

The Plan is consumed by `irgfw_gym.IrgfwEnv.step()`, which opens the TCP
connection, transmits per the plan, observes the verdict, and feeds it
back to the RL agent as the reward signal.
"""

from __future__ import annotations
import os
import random
import struct
from dataclasses import dataclass, field
from typing import Callable, Optional


# ---- TLS ClientHello builder primitives (mirrors dpi_fuzzer.py) ----

def _u8(v):  return bytes([v])
def _u16(v): return struct.pack(">H", v)
def _u24(v): return struct.pack(">I", v)[1:]
def _p1(b):  return _u8(len(b)) + b
def _p2(b):  return _u16(len(b)) + b
def _p3(b):  return _u24(len(b)) + b


def _ext_sni(name: str, length_fudge: int = 0) -> bytes:
    name_b = name.encode("ascii")
    host_entry = _u8(0) + _p2(name_b)
    inner = _p2(host_entry)
    if length_fudge:
        return _u16(0x0000) + _u16(len(inner) + length_fudge) + inner
    return _u16(0x0000) + _p2(inner)


def _ext_supported_versions() -> bytes:
    return _u16(0x002b) + _p2(_p1(_u16(0x0304)))


def _ext_supported_groups(pq: bool = False, classical: bool = True) -> bytes:
    g = b""
    if pq:        g += _u16(0x11ec)              # X25519MLKEM768
    if classical: g += _u16(0x001d) + _u16(0x0017)
    return _u16(0x000a) + _p2(_p2(g))


def _ext_key_share() -> bytes:
    pub = os.urandom(32)
    entry = _u16(0x001d) + _p2(pub)
    return _u16(0x0033) + _p2(_p2(entry))


def _ext_sig_algs() -> bytes:
    return _u16(0x000d) + _p2(_p2(_u16(0x0804) + _u16(0x0403) + _u16(0x0401)))


def _ext_padding(n: int) -> bytes:
    return _u16(0x0015) + _p2(b"\x00" * n)


def _ext_grease(eid: int = 0x0a0a) -> bytes:
    return _u16(eid) + _p2(b"")


def _ext_random_unknown() -> bytes:
    eid = random.randint(0xFF00, 0xFFFE)
    return _u16(eid) + _p2(os.urandom(random.randint(4, 24)))


def build_clienthello(
    sni: Optional[str],
    extra_exts: tuple[bytes, ...] = (),
    duplicate_sni: bool = False,
    sni_last: bool = False,
    session_id: bytes = b"",
    sni_length_fudge: int = 0,
    grease: bool = False,
) -> bytes:
    body = _u16(0x0303) + os.urandom(32)
    body += _p1(session_id)
    body += _p2(_u16(0x1301) + _u16(0x1303) + _u16(0x1302))
    body += _u8(1) + _u8(0)            # null compression

    exts = b""
    if grease:
        exts += _ext_grease()
    if not sni_last and sni is not None:
        exts += _ext_sni(sni, length_fudge=sni_length_fudge)
        if duplicate_sni:
            exts += _ext_sni(sni)
    exts += _ext_supported_versions()
    exts += _ext_supported_groups()
    exts += _ext_key_share()
    exts += _ext_sig_algs()
    for e in extra_exts:
        exts += e
    if sni_last and sni is not None:
        exts += _ext_sni(sni, length_fudge=sni_length_fudge)

    body += _p2(exts)
    handshake = _u8(0x01) + _p3(body)
    return _u8(0x16) + _u16(0x0301) + _p2(handshake)


def wrap_two_records(hello: bytes) -> bytes:
    inner = hello[5:]
    split_at = 20 if len(inner) > 40 else len(inner) // 2
    r1 = _u8(0x16) + _u16(0x0301) + _p2(inner[:split_at])
    r2 = _u8(0x16) + _u16(0x0301) + _p2(inner[split_at:])
    return r1 + r2


# ---- Plan ----

@dataclass
class Plan:
    """How to transmit one episode's worth of bytes."""
    chunks: list[bytes]
    delay_between_ms: int = 0
    pre_connect_byte: bool = False
    name: str = ""
    description: str = ""
    cost: float = 1.0      # higher = "more elaborate"; reward shaping encourages cheap winners


# ---- The catalogue ----

MutationFn = Callable[[str], Plan]


def _baseline_blocked(sni: str) -> Plan:
    return Plan([build_clienthello(sni)], name="baseline_blocked", cost=0.1)


def _baseline_clean(sni: str) -> Plan:
    return Plan([build_clienthello("www.google.com")], name="baseline_clean", cost=0.1)


# TCP segmentation
def _split_byte(n: int) -> MutationFn:
    def f(sni: str) -> Plan:
        ch = build_clienthello(sni)
        return Plan([ch[:n], ch[n:]], name=f"split_byte{n}", cost=1.2)
    return f


def _split_inside_sni(sni: str) -> Plan:
    ch = build_clienthello(sni)
    sni_b = sni.encode()
    off = ch.find(sni_b)
    if off <= 0 or off >= len(ch) - 1:
        return Plan([ch], name="split_inside_sni_fallback", cost=1.2)
    mid = off + len(sni_b) // 2
    return Plan([ch[:mid], ch[mid:]], name="split_inside_sni", cost=1.5)


def _split_mid(sni: str) -> Plan:
    ch = build_clienthello(sni)
    half = len(ch) // 2
    return Plan([ch[:half], ch[half:]], name="split_mid", cost=1.2)


def _multisplit_4(sni: str) -> Plan:
    ch = build_clienthello(sni)
    n = max(1, len(ch) // 4)
    chunks = [ch[i:i + n] for i in range(0, len(ch), n) if ch[i:i + n]]
    return Plan(chunks, name="multisplit_4", cost=1.6)


def _split_delayed(ms: int) -> MutationFn:
    def f(sni: str) -> Plan:
        ch = build_clienthello(sni)
        half = len(ch) // 2
        return Plan([ch[:half], ch[half:]], delay_between_ms=ms,
                    name=f"split_delayed_{ms}ms", cost=1.4 + ms / 1000.0)
    return f


# TLS record layer
def _tls_two_records(sni: str) -> Plan:
    return Plan([wrap_two_records(build_clienthello(sni))],
                name="tls_two_records", cost=1.3)


def _tls_two_records_tcpsplit(sni: str) -> Plan:
    rec = wrap_two_records(build_clienthello(sni))
    return Plan([rec[:25], rec[25:]], name="tls_two_records_tcpsplit", cost=1.5)


# SNI encoding tricks
def _dup_sni(sni: str) -> Plan:
    return Plan([build_clienthello(sni, duplicate_sni=True)],
                name="dup_sni_ext", cost=1.1)


def _sni_last(sni: str) -> Plan:
    return Plan([build_clienthello(sni, sni_last=True)],
                name="sni_last_extension", cost=1.1)


def _sni_case_upper(sni: str) -> Plan:
    return Plan([build_clienthello(sni.upper())],
                name="sni_case_upper", cost=1.05)


def _sni_case_mixed(sni: str) -> Plan:
    mixed = "".join(c.upper() if i % 2 else c for i, c in enumerate(sni))
    return Plan([build_clienthello(mixed)], name="sni_case_mixed", cost=1.05)


def _sni_trailing_dot(sni: str) -> Plan:
    return Plan([build_clienthello(sni + ".")], name="sni_trailing_dot", cost=1.05)


def _sni_length_fudge(delta: int) -> MutationFn:
    def f(sni: str) -> Plan:
        return Plan([build_clienthello(sni, sni_length_fudge=delta)],
                    name=f"sni_length_{'plus' if delta>=0 else 'minus'}{abs(delta)}",
                    cost=1.2)
    return f


def _random_session_id(sni: str) -> Plan:
    return Plan([build_clienthello(sni, session_id=os.urandom(32))],
                name="sni_random_session_id", cost=1.1)


# ClientHello stuffing
def _padding(n: int) -> MutationFn:
    def f(sni: str) -> Plan:
        return Plan([build_clienthello(sni, extra_exts=(_ext_padding(n),))],
                    name=f"extra_padding_{n}", cost=1.2)
    return f


def _many_unknown_extensions(n: int) -> MutationFn:
    def f(sni: str) -> Plan:
        exts = tuple(_ext_random_unknown() for _ in range(n))
        return Plan([build_clienthello(sni, extra_exts=exts)],
                    name=f"many_extensions_{n}", cost=1.3)
    return f


def _grease_first(sni: str) -> Plan:
    return Plan([build_clienthello(sni, grease=True)],
                name="grease_first", cost=1.05)


def _pq_kem(sni: str) -> Plan:
    return Plan([build_clienthello(sni,
                                   extra_exts=(_ext_supported_groups(pq=True, classical=False),))],
                name="pq_kem_group", cost=1.1)


# Decoy / desync
def _fake_clean_then_real(sni: str) -> Plan:
    clean = build_clienthello("www.google.com")
    real  = build_clienthello(sni)
    return Plan([clean, real], delay_between_ms=10,
                name="fake_clean_then_real", cost=1.6)


def _double_blocked(sni: str) -> Plan:
    ch = build_clienthello(sni)
    return Plan([ch, ch], delay_between_ms=10, name="double_blocked", cost=1.4)


def _preconnect_null(sni: str) -> Plan:
    return Plan([build_clienthello(sni)], pre_connect_byte=True,
                name="preconnect_null_byte", cost=1.1)


# Chains (the Geneva-style compositions, ~22 of these)
def _chain_split_pq(sni: str) -> Plan:
    ch = build_clienthello(sni,
                           extra_exts=(_ext_supported_groups(pq=True, classical=False),))
    return Plan([ch[:1], ch[1:]], name="chain:split_byte1+pq_kem", cost=1.5)


def _chain_split_pad(sni: str) -> Plan:
    ch = build_clienthello(sni, extra_exts=(_ext_padding(2000),))
    return Plan([ch[:1], ch[1:]], name="chain:split_byte1+pad2000", cost=1.6)


def _chain_records_pad(sni: str) -> Plan:
    ch = build_clienthello(sni, extra_exts=(_ext_padding(2000),))
    return Plan([wrap_two_records(ch)], name="chain:tls_two_records+pad2000", cost=1.5)


def _chain_dup_split(sni: str) -> Plan:
    ch = build_clienthello(sni, duplicate_sni=True)
    return Plan([ch[:5], ch[5:]], name="chain:dup_sni+split5", cost=1.5)


def _chain_inside_sni_delayed(sni: str) -> Plan:
    ch = build_clienthello(sni)
    sni_b = sni.encode()
    off = ch.find(sni_b)
    mid = off + len(sni_b) // 2 if off > 0 else len(ch) // 2
    return Plan([ch[:mid], ch[mid:]], delay_between_ms=50,
                name="chain:split_inside_sni+50ms_delay", cost=1.7)


def _chain_fake_then_split(sni: str) -> Plan:
    clean = build_clienthello("www.google.com")
    real  = build_clienthello(sni)
    return Plan([clean, real[:5], real[5:]], delay_between_ms=10,
                name="chain:fake_clean_then_real+split", cost=1.8)


def _chain_pq_split_inside(sni: str) -> Plan:
    ch = build_clienthello(sni,
                           extra_exts=(_ext_supported_groups(pq=True, classical=False),))
    sni_b = sni.encode()
    off = ch.find(sni_b)
    mid = off + len(sni_b) // 2 if off > 0 else len(ch) // 2
    return Plan([ch[:mid], ch[mid:]], name="chain:pq+split_inside_sni", cost=1.7)


def _chain_records_split(sni: str) -> Plan:
    rec = wrap_two_records(build_clienthello(sni))
    return Plan([rec[:25], rec[25:]], name="chain:tls_two_records+split25", cost=1.5)


def _chain_pad_dup(sni: str) -> Plan:
    ch = build_clienthello(sni, duplicate_sni=True,
                           extra_exts=(_ext_padding(2000),))
    return Plan([ch], name="chain:dup_sni+pad2000", cost=1.4)


def _chain_pad_case(sni: str) -> Plan:
    ch = build_clienthello(sni.upper(), extra_exts=(_ext_padding(1500),))
    return Plan([ch], name="chain:case+pad1500", cost=1.4)


def _chain_long_padding(sni: str) -> Plan:
    ch = build_clienthello(sni, extra_exts=(_ext_padding(8000),))
    return Plan([ch], name="chain:padding_8000", cost=1.4)


def _chain_many_ext_split(sni: str) -> Plan:
    exts = tuple(_ext_random_unknown() for _ in range(20))
    ch = build_clienthello(sni, extra_exts=exts)
    return Plan([ch[:1], ch[1:]], name="chain:many_ext+split_byte1", cost=1.7)


def _chain_grease_pad(sni: str) -> Plan:
    ch = build_clienthello(sni, grease=True, extra_exts=(_ext_padding(1500),))
    return Plan([ch], name="chain:grease+pad", cost=1.3)


def _chain_double_split(sni: str) -> Plan:
    ch = build_clienthello(sni)
    return Plan([ch[:1], ch[1:5], ch[5:]], delay_between_ms=20,
                name="chain:triple_split", cost=1.6)


def _chain_session_id_split(sni: str) -> Plan:
    ch = build_clienthello(sni, session_id=os.urandom(32))
    return Plan([ch[:5], ch[5:]], name="chain:session_id+split", cost=1.4)


def _chain_decoy_pq(sni: str) -> Plan:
    clean = build_clienthello("www.google.com",
                              extra_exts=(_ext_supported_groups(pq=True, classical=True),))
    real  = build_clienthello(sni)
    return Plan([clean, real], delay_between_ms=5,
                name="chain:decoy_pq+real", cost=1.7)


def _chain_records_delayed(sni: str) -> Plan:
    rec = wrap_two_records(build_clienthello(sni))
    return Plan([rec[:25], rec[25:]], delay_between_ms=100,
                name="chain:two_records+100ms", cost=1.6)


def _chain_inside_sni_pq(sni: str) -> Plan:
    ch = build_clienthello(sni,
                           extra_exts=(_ext_supported_groups(pq=True, classical=False),))
    sni_b = sni.encode()
    off = ch.find(sni_b)
    mid = off + len(sni_b) // 2 if off > 0 else len(ch) // 2
    return Plan([ch[:mid], ch[mid:]], delay_between_ms=10,
                name="chain:inside_sni+pq+delay", cost=1.8)


def _chain_pre_byte_split(sni: str) -> Plan:
    ch = build_clienthello(sni)
    return Plan([ch[:1], ch[1:]], pre_connect_byte=True,
                name="chain:preconnect+split_byte1", cost=1.4)


def _chain_pre_byte_records(sni: str) -> Plan:
    return Plan([wrap_two_records(build_clienthello(sni))], pre_connect_byte=True,
                name="chain:preconnect+two_records", cost=1.4)


def _chain_dup_records(sni: str) -> Plan:
    rec = wrap_two_records(build_clienthello(sni, duplicate_sni=True))
    return Plan([rec], name="chain:dup_sni+two_records", cost=1.5)


def _chain_full_house(sni: str) -> Plan:
    """Compose four primitives at once: pq + dup_sni + padding + split inside SNI."""
    ch = build_clienthello(
        sni,
        duplicate_sni=True,
        extra_exts=(_ext_supported_groups(pq=True, classical=False),
                    _ext_padding(1000)),
    )
    sni_b = sni.encode()
    off = ch.find(sni_b)
    mid = off + len(sni_b) // 2 if off > 0 else len(ch) // 2
    return Plan([ch[:mid], ch[mid:]], delay_between_ms=20,
                name="chain:full_house", cost=2.0)


# ---------------------------------------------------------------------------
# uTLS browser-mimicry mutations — defeat JA3/JA4 fingerprint checks
# and entropy classifiers by emitting bytes that look exactly like a
# real Chrome/Firefox/Safari handshake. Required against profile mci_v2.
# ---------------------------------------------------------------------------

def _utls_chrome(sni: str) -> Plan:
    from .utls_templates import chrome_120_clienthello
    return Plan([chrome_120_clienthello(sni)],
                name="utls_chrome_120", cost=1.0)


def _utls_firefox(sni: str) -> Plan:
    from .utls_templates import firefox_120_clienthello
    return Plan([firefox_120_clienthello(sni)],
                name="utls_firefox_120", cost=1.0)


def _utls_safari(sni: str) -> Plan:
    from .utls_templates import safari_17_clienthello
    return Plan([safari_17_clienthello(sni)],
                name="utls_safari_17", cost=1.0)


def _utls_chrome_split(sni: str) -> Plan:
    """Chrome mimicry + TCP fragmentation. Browser fingerprint passes
    JA3, fragmented bytes defeat any reassembling SNI matcher."""
    from .utls_templates import chrome_120_clienthello
    ch = chrome_120_clienthello(sni)
    return Plan([ch[:1], ch[1:]], name="chain:utls_chrome+split_byte1", cost=1.2)


def _utls_chrome_inside_sni_split(sni: str) -> Plan:
    from .utls_templates import chrome_120_clienthello
    ch = chrome_120_clienthello(sni)
    sni_b = sni.encode()
    off = ch.find(sni_b)
    mid = off + len(sni_b) // 2 if off > 0 else len(ch) // 2
    return Plan([ch[:mid], ch[mid:]],
                name="chain:utls_chrome+split_inside_sni", cost=1.4)


def _utls_firefox_split(sni: str) -> Plan:
    from .utls_templates import firefox_120_clienthello
    ch = firefox_120_clienthello(sni)
    return Plan([ch[:1], ch[1:]], name="chain:utls_firefox+split_byte1", cost=1.2)


def _utls_chrome_two_records(sni: str) -> Plan:
    from .utls_templates import chrome_120_clienthello
    return Plan([wrap_two_records(chrome_120_clienthello(sni))],
                name="chain:utls_chrome+two_records", cost=1.3)


def _utls_chrome_decoy(sni: str) -> Plan:
    """Decoy clean Chrome ClientHello, then real Chrome ClientHello with
    blocked SNI — both match Chrome JA3, decoy-then-real defeats SNI
    matcher, both pass entropy."""
    from .utls_templates import chrome_120_clienthello
    decoy = chrome_120_clienthello("www.google.com")
    real  = chrome_120_clienthello(sni)
    return Plan([decoy, real], delay_between_ms=10,
                name="chain:utls_chrome_decoy+real", cost=1.6)


# Master list. Index in this list IS the discrete-action ID the RL agent
# emits.
CATALOG: list[MutationFn] = [
    # 0–1: baselines
    _baseline_blocked,
    _baseline_clean,
    # 2–10: TCP segmentation
    _split_byte(1), _split_byte(3), _split_byte(5),
    _split_mid, _multisplit_4,
    _split_delayed(100), _split_delayed(500),
    _split_inside_sni,
    _tls_two_records,
    # 11–14: TLS record layer + session id
    _tls_two_records_tcpsplit,
    _random_session_id,
    _grease_first,
    _pq_kem,
    # 15–22: SNI encoding
    _dup_sni, _sni_last,
    _sni_case_upper, _sni_case_mixed, _sni_trailing_dot,
    _sni_length_fudge(+1), _sni_length_fudge(-1),
    _padding(1200),
    # 23–28: padding / many extensions / decoy / preconnect
    _padding(4000),
    _many_unknown_extensions(20),
    _fake_clean_then_real,
    _double_blocked,
    _preconnect_null,
    _padding(2500),
    # 29–49: chains (Geneva-style compositions)
    _chain_split_pq, _chain_split_pad, _chain_records_pad,
    _chain_dup_split, _chain_inside_sni_delayed,
    _chain_fake_then_split, _chain_pq_split_inside,
    _chain_records_split, _chain_pad_dup, _chain_pad_case,
    _chain_long_padding, _chain_many_ext_split, _chain_grease_pad,
    _chain_double_split, _chain_session_id_split,
    _chain_decoy_pq, _chain_records_delayed,
    _chain_inside_sni_pq, _chain_pre_byte_split,
    _chain_pre_byte_records, _chain_dup_records,
    _chain_full_house,
    # 51-58: uTLS browser mimicry — required against mci_v2 profile
    _utls_chrome, _utls_firefox, _utls_safari,
    _utls_chrome_split, _utls_chrome_inside_sni_split,
    _utls_firefox_split, _utls_chrome_two_records,
    _utls_chrome_decoy,
]


# Insert new mutations discovered by reverse-engineering real Shatel
# DPI (April 2026). Append to keep action-id stability for older
# checkpoints; new IDs are 59+.

def _dup_sni_blocked_then_clean(sni: str) -> Plan:
    """Two SNI extensions: blocked first, clean second. Bypasses DPIs
    that read the LAST SNI (real Shatel's behaviour, discovered by
    reverse_engineer.py:e5). The server typically also reads last
    so this only delivers a connection to the *clean* SNI's cert
    space — useful for measurement, not for actual circumvention to
    the blocked SNI."""
    body = _u16(0x0303) + os.urandom(32)
    body += _p1(b"")
    body += _p2(_u16(0x1301) + _u16(0x1303) + _u16(0x1302))
    body += _u8(1) + _u8(0)
    exts = _ext_sni(sni) + _ext_sni("www.google.com")
    exts += _ext_supported_versions()
    exts += _ext_supported_groups()
    exts += _ext_key_share()
    exts += _ext_sig_algs()
    body += _p2(exts)
    handshake = _u8(0x01) + _p3(body)
    record = _u8(0x16) + _u16(0x0301) + _p2(handshake)
    return Plan([record], name="dup_sni_blocked_first_clean_last", cost=1.1)


def _split_5s_gap(sni: str) -> Plan:
    """Split CH at byte 1, with 5-second gap between segments.
    Beats Shatel's TCP-reassembly buffer (2-5 s holding window). Slow
    by definition (5 s extra latency), but works where shorter gaps
    don't."""
    ch = build_clienthello(sni)
    return Plan([ch[:1], ch[1:]], delay_between_ms=5000,
                name="split_5s_gap", cost=2.5)


def _split_with_handshake_resync(sni: str) -> Plan:
    """Split inside the ClientHello body but at a TLS-record boundary
    so the wire form looks like two complete TLS records emitted with
    enough gap (>2 s) for the DPI buffer to flush."""
    ch = build_clienthello(sni)
    rec = wrap_two_records(ch)
    return Plan([rec[:25], rec[25:]], delay_between_ms=2200,
                name="split_records_2200ms_gap", cost=2.3)


CATALOG.extend([
    _dup_sni_blocked_then_clean,        # 59
    _split_5s_gap,                      # 60
    _split_with_handshake_resync,       # 61
])

assert 48 <= len(CATALOG) <= 60, f"catalog must have ~50-60 entries, has {len(CATALOG)}"
N_ACTIONS = len(CATALOG)


def get(action_id: int, sni: str) -> Plan:
    """Materialize the action-id's plan for a given target SNI."""
    return CATALOG[action_id](sni)


def names() -> list[str]:
    """Return a representative name for each action — useful for logging
    and the action-frequency heatmap (E3)."""
    return [fn("www.example.com").name for fn in CATALOG]
