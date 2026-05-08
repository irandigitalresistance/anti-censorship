"""rlagent/envs/utls_templates.py

Browser ClientHello templates that produce realistic JA3/JA4 fingerprints.
Follows the public uTLS library (refraction-networking/utls) approach:
emit the *exact* cipher suite list, extension order, and GREASE pattern
that the real browser ships, with only the SNI extension and the random
nonce changing per call.

The templates here are minimised approximations of:
  - Chrome 120 stable (April 2024 fingerprint)
  - Firefox 120 stable
  - Safari 17 macOS
  - Edge 120 (almost identical to Chrome on Chromium)

Real-world uTLS ships dozens of these; we ship four — enough that the
JA3 allowlist in env/dpi/modules/ja3_matcher.py has a non-trivial set
to recognise.

The simulator's JA3 allowlist accepts the JA3 hashes computed from
these templates exactly (see tests/test_ja3_consistency.py).
"""
from __future__ import annotations
import os
import struct

from .mutations import _u8, _u16, _u24, _p1, _p2, _p3


# ---------- GREASE values (rotated per Chrome version) ----------

# Standard GREASE values 0x0a0a..0xfafa. Chrome picks one per
# negotiation; we always pick the same one for determinism.
GREASE_VERSIONS = 0x0a0a
GREASE_CIPHERS  = 0x1a1a
GREASE_EXT_FIRST = 0x2a2a
GREASE_EXT_LAST  = 0x3a3a
GREASE_GROUPS   = 0x4a4a
GREASE_KEYSHARE = 0x5a5a


# ---------- TLS extension builders for the templates ----------

def _ext(eid: int, body: bytes) -> bytes:
    return _u16(eid) + _p2(body)


def _ext_sni(name: str) -> bytes:
    name_b = name.encode("ascii")
    host_entry = _u8(0) + _p2(name_b)
    return _ext(0x0000, _p2(host_entry))


def _ext_supported_versions_browser() -> bytes:
    """Chrome/Firefox ship 0x0304 (TLS 1.3) and 0x0303 (TLS 1.2),
    optionally a GREASE version first."""
    body = _p1(_u16(GREASE_VERSIONS) + _u16(0x0304) + _u16(0x0303))
    return _ext(0x002b, body)


def _ext_supported_groups_chrome() -> bytes:
    """Chrome supported groups: GREASE, x25519, secp256r1, secp384r1.
    Recent Chrome (124+) prepends X25519MLKEM768 (0x11ec)."""
    groups = (_u16(GREASE_GROUPS) + _u16(0x001d)  # x25519
              + _u16(0x0017)                       # secp256r1
              + _u16(0x0018))                      # secp384r1
    return _ext(0x000a, _p2(groups))


def _ext_supported_groups_firefox() -> bytes:
    """Firefox: x25519, secp256r1, secp384r1, secp521r1, ffdhe2048, ffdhe3072."""
    groups = (_u16(0x001d) + _u16(0x0017) + _u16(0x0018) + _u16(0x0019)
              + _u16(0x0100) + _u16(0x0101))
    return _ext(0x000a, _p2(groups))


def _ext_key_share_chrome() -> bytes:
    """Chrome key share: GREASE entry (1 byte) + x25519 entry (32 bytes)."""
    pub = os.urandom(32)
    grease_entry = _u16(GREASE_KEYSHARE) + _p2(b"\x00")
    x25519_entry = _u16(0x001d) + _p2(pub)
    return _ext(0x0033, _p2(grease_entry + x25519_entry))


def _ext_key_share_firefox() -> bytes:
    pub = os.urandom(32)
    return _ext(0x0033, _p2(_u16(0x001d) + _p2(pub)))


def _ext_sig_algs_browser() -> bytes:
    """Chrome / Firefox shared signature algorithms."""
    algs = (_u16(0x0403) + _u16(0x0804) + _u16(0x0401)
            + _u16(0x0503) + _u16(0x0805) + _u16(0x0501)
            + _u16(0x0806) + _u16(0x0601))
    return _ext(0x000d, _p2(algs))


def _ext_alpn_browser() -> bytes:
    inner = _p1(b"h2") + _p1(b"http/1.1")
    return _ext(0x0010, _p2(inner))


def _ext_supported_formats_uncompressed() -> bytes:
    return _ext(0x000b, _p1(b"\x00"))


def _ext_session_ticket() -> bytes:
    return _ext(0x0023, b"")


def _ext_extended_master_secret() -> bytes:
    return _ext(0x0017, b"")


def _ext_renegotiation_info() -> bytes:
    return _ext(0xff01, _p1(b""))


def _ext_psk_key_exchange_modes() -> bytes:
    return _ext(0x002d, _p1(b"\x01"))   # psk_dhe_ke


def _ext_record_size_limit() -> bytes:
    return _ext(0x001c, _u16(16385))


def _ext_status_request() -> bytes:
    return _ext(0x0005, b"\x01\x00\x00\x00\x00")


def _ext_signed_cert_timestamp() -> bytes:
    return _ext(0x0012, b"")


def _ext_compress_certificate_brotli() -> bytes:
    return _ext(0x001b, _p1(_u16(0x0002)))


def _ext_application_settings() -> bytes:
    return _ext(0x4469, _p2(_p1(b"h2")))


def _ext_grease_padding(min_pad: int = 200) -> bytes:
    """Chrome's last extension is a padding extension that pads the
    ClientHello to a multiple of 512 bytes. We approximate."""
    return _ext(0x0015, b"\x00" * min_pad)


# ---------- Cipher suite lists ----------

CHROME_CIPHERS = [
    GREASE_CIPHERS,
    0x1301, 0x1302, 0x1303,            # TLS 1.3 trio
    0xc02c, 0xc02b, 0xc030, 0xc02f,    # ECDHE-ECDSA/RSA AES-256/128-GCM
    0xcca9, 0xcca8,                    # ECDHE-CHACHA20
    0xc024, 0xc023, 0xc028, 0xc027,
    0xc00a, 0xc009, 0xc014, 0xc013,
    0x009d, 0x009c, 0x003d, 0x003c, 0x0035, 0x002f,
]

FIREFOX_CIPHERS = [
    0x1301, 0x1303, 0x1302,
    0xc02b, 0xc02f, 0xcca9, 0xcca8,
    0xc02c, 0xc030, 0xc00a, 0xc009, 0xc013, 0xc014,
    0x009c, 0x009d, 0x002f, 0x0035,
]

SAFARI_CIPHERS = [
    GREASE_CIPHERS,
    0x1301, 0x1302, 0x1303,
    0xc02c, 0xc02b, 0xcca9, 0xc030, 0xc02f, 0xcca8,
    0xc024, 0xc023, 0xc00a, 0xc009,
    0xc028, 0xc027, 0xc014, 0xc013,
    0x009d, 0x009c, 0x003d, 0x003c, 0x0035, 0x002f,
]


# ---------- Whole-ClientHello builders ----------

def _build_hello(sni: str, cipher_suites: list[int],
                 extensions: list[bytes]) -> bytes:
    body = _u16(0x0303) + os.urandom(32)
    body += _p1(os.urandom(32))                                # session id
    body += _p2(b"".join(_u16(c) for c in cipher_suites))
    body += _u8(1) + _u8(0)
    exts = b""
    for e in extensions:
        exts += e
    body += _p2(exts)
    handshake = _u8(0x01) + _p3(body)
    return _u8(0x16) + _u16(0x0301) + _p2(handshake)


def chrome_120_clienthello(sni: str) -> bytes:
    return _build_hello(sni, CHROME_CIPHERS, [
        _ext_grease_padding(0),
        _ext_sni(sni),
        _ext_extended_master_secret(),
        _ext_renegotiation_info(),
        _ext_supported_groups_chrome(),
        _ext_supported_formats_uncompressed(),
        _ext_session_ticket(),
        _ext_alpn_browser(),
        _ext_status_request(),
        _ext_sig_algs_browser(),
        _ext_signed_cert_timestamp(),
        _ext_key_share_chrome(),
        _ext_psk_key_exchange_modes(),
        _ext_supported_versions_browser(),
        _ext_compress_certificate_brotli(),
        _ext_application_settings(),
        _ext(GREASE_EXT_LAST, b""),
        _ext_grease_padding(min_pad=128),
    ])


def firefox_120_clienthello(sni: str) -> bytes:
    return _build_hello(sni, FIREFOX_CIPHERS, [
        _ext_sni(sni),
        _ext_extended_master_secret(),
        _ext_renegotiation_info(),
        _ext_supported_groups_firefox(),
        _ext_supported_formats_uncompressed(),
        _ext_session_ticket(),
        _ext_alpn_browser(),
        _ext_status_request(),
        _ext_sig_algs_browser(),
        _ext_signed_cert_timestamp(),
        _ext_key_share_firefox(),
        _ext_psk_key_exchange_modes(),
        _ext_supported_versions_browser(),
        _ext_record_size_limit(),
    ])


def safari_17_clienthello(sni: str) -> bytes:
    return _build_hello(sni, SAFARI_CIPHERS, [
        _ext(GREASE_EXT_FIRST, b""),
        _ext_sni(sni),
        _ext_extended_master_secret(),
        _ext_renegotiation_info(),
        _ext_supported_groups_chrome(),
        _ext_supported_formats_uncompressed(),
        _ext_alpn_browser(),
        _ext_status_request(),
        _ext_sig_algs_browser(),
        _ext_signed_cert_timestamp(),
        _ext_key_share_chrome(),
        _ext_psk_key_exchange_modes(),
        _ext_supported_versions_browser(),
        _ext(GREASE_EXT_LAST, b""),
    ])


def edge_120_clienthello(sni: str) -> bytes:
    """Edge is Chromium-based; same JA3 as Chrome."""
    return chrome_120_clienthello(sni)
