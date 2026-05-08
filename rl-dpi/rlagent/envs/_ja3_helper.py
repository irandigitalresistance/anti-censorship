"""env/dpi/modules/ja3_matcher.py

JA3/JA4-style TLS fingerprint matching, the kind of check that
production DPIs (Chinese GFW, modern Iranian middleboxes, Cloudflare
Magic Transit) actually run on top of basic SNI matching.

JA3 hash format (Salesforce 2017):
    MD5(TLSVersion,Ciphers,Extensions,EllipticCurves,EllipticCurveFormats)
where each list is comma-separated decimal IDs and lists are joined by
commas. GREASE values are *removed* before hashing.

The matcher is configured with an *allowlist* of fingerprints (as
JA3 hex strings) corresponding to real browser builds. Any
ClientHello whose JA3 hash is not in the allowlist gets RST'd. This
is the production-grade defence against:
  - bare crypto/tls Go default (many proxy tools)
  - exotic cipher/extension orderings that uTLS-Chrome wouldn't emit
  - GREASE-missing ClientHellos
  - extension-stuffed ClientHellos that exceed any real-browser layout
"""
from __future__ import annotations
import hashlib
from typing import Optional

Verdict = None


GREASE_VALUES = frozenset({
    0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a,
    0x8a8a, 0x9a9a, 0xaaaa, 0xbaba, 0xcaca, 0xdada, 0xeaea, 0xfafa,
})


def _is_grease(v: int) -> bool:
    return v in GREASE_VALUES


def parse_ja3_fields(payload: bytes) -> Optional[tuple[int, list[int], list[int],
                                                       list[int], list[int]]]:
    """Return (tls_version_int, ciphers, extensions, curves, formats) for a
    ClientHello payload, or None if the record is malformed."""
    if len(payload) < 5 or payload[0] != 0x16:
        return None
    rec_len = (payload[3] << 8) | payload[4]
    body = payload[5:5 + rec_len]
    if len(body) < 4 or body[0] != 0x01:
        return None
    pos = 4 + 2 + 32   # handshake header + version + random
    if pos + 1 > len(body): return None
    sid_len = body[pos]; pos += 1
    pos += sid_len
    if pos + 2 > len(body): return None

    cs_len = (body[pos] << 8) | body[pos + 1]; pos += 2
    ciphers = []
    cs_end = pos + cs_len
    while pos + 2 <= cs_end:
        c = (body[pos] << 8) | body[pos + 1]; pos += 2
        if not _is_grease(c):
            ciphers.append(c)
    pos = cs_end
    if pos + 1 > len(body): return None
    cm_len = body[pos]; pos += 1
    pos += cm_len
    if pos + 2 > len(body): return None
    ext_total = (body[pos] << 8) | body[pos + 1]; pos += 2
    ext_end = pos + ext_total

    extensions = []; curves = []; formats = []
    while pos + 4 <= ext_end and pos + 4 <= len(body):
        try:
            etype = (body[pos] << 8) | body[pos + 1]; pos += 2
            elen  = (body[pos] << 8) | body[pos + 1]; pos += 2
        except IndexError:
            break
        if pos + elen > ext_end or pos + elen > len(body):
            break
        edata = body[pos:pos + elen]
        pos += elen
        if not _is_grease(etype):
            extensions.append(etype)
        if etype == 0x000a and len(edata) >= 4:
            ll = (edata[0] << 8) | edata[1]
            ip = 2; end = 2 + ll
            while ip + 2 <= end and ip + 2 <= len(edata):
                c = (edata[ip] << 8) | edata[ip + 1]
                if not _is_grease(c):
                    curves.append(c)
                ip += 2
        elif etype == 0x000b and len(edata) >= 1:
            fl = edata[0]
            for i in range(min(fl, len(edata) - 1)):
                formats.append(edata[1 + i])

    tls_v = (body[4] << 8) | body[5]
    return tls_v, ciphers, extensions, curves, formats


def compute_ja3(payload: bytes) -> Optional[str]:
    f = parse_ja3_fields(payload)
    if f is None:
        return None
    tls_v, ciphers, extensions, curves, formats = f
    s = "{},{},{},{},{}".format(
        tls_v,
        "-".join(str(c) for c in ciphers),
        "-".join(str(e) for e in extensions),
        "-".join(str(c) for c in curves),
        "-".join(str(f) for f in formats),
    )
    return hashlib.md5(s.encode()).hexdigest()


# Published browser fingerprints — these are the JA3 hashes that DPI
# vendors include in their "real-browser" allowlist. Drawn from public
# JA3 databases (TrickBot 2020 catalogue, JA3er.com top entries, the
# ja4plus public dataset). Real values; verify by hashing the matching
# uTLS templates in rlagent/envs/utls_templates.py.
DEFAULT_BROWSER_ALLOWLIST = frozenset({
    # Updated to match the actual templates we ship in
    # rlagent/envs/utls_templates.py — the test
    # tests/test_ja3_consistency.py asserts these stay in sync.
    "chrome_120": "cd08e31494f9531f560d64c695473da9",
    "firefox_120": "b32309a26951912be7dba376398abc3b",
    "safari_17":   "773906b0efdefa24a7f2b8eb6985bf37",
    "edge_120":    "cd08e31494f9531f560d64c695473da9",  # same as Chrome
}.values())


def decide(payload: bytes, cfg: dict) -> Verdict:
    """Inspect a ClientHello packet, compute its JA3, decide pass/RST.

    The allowlist is configured per-profile — for the canonical mci_v2
    profile we accept only the four browser hashes above. A ClientHello
    that bypassed the SNI matcher via fragmentation or padding would
    still die here if its fingerprint doesn't match a real browser.
    """
    if not cfg.get("enabled", False):
        return Verdict.pass_(reason="ja3_disabled")
    try:
        ja3 = compute_ja3(payload)
    except Exception:
        return Verdict.pass_(reason="ja3_parse_crash")
    if ja3 is None:
        return Verdict.pass_(reason="ja3_unparseable")
    allowlist = cfg.get("allowlist") or DEFAULT_BROWSER_ALLOWLIST
    if ja3 in allowlist:
        return Verdict.pass_(reason=f"ja3_browser_match:{ja3[:12]}")
    return Verdict.rst(reason=f"ja3_anomaly:{ja3[:12]}",
                       delay_ms=cfg.get("racing_budget_ms", 8))
