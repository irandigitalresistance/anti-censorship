"""Verbose login script. Captures the full exception chain and the raw
protobuf response so we can diagnose aiobale parse failures.

Usage (Windows PowerShell, inside bale-sidecar folder with venv activated):

    python -m bale_sidecar.debug_login send <phone>
    python -m bale_sidecar.debug_login verify <otp>

State + raw bytes saved to ~\.webtunnel\debug-login-*.bin
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import traceback
from pathlib import Path

from aiobale import Client, Dispatcher
from aiobale.enums import AuthErrors, SendCodeType
from aiobale.methods.auth import ValidateCode


STATE_DIR = Path(os.path.expanduser("~/.webtunnel"))
STATE_FILE = STATE_DIR / "debug-login-state.json"
RAW_FILE = STATE_DIR / "debug-login-response.bin"


async def cmd_send(phone: str) -> int:
    phone_i = int(phone.replace("+", "").strip())
    dp = Dispatcher()
    session_path = str(STATE_DIR / "server-session.bale")
    client = Client(dp, session_file=session_path)
    resp = await client.start_phone_auth(
        phone_number=phone_i, code_type=SendCodeType.DEFAULT
    )
    if isinstance(resp, AuthErrors):
        print(f"start_phone_auth failed: {resp!r}")
        return 3
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps({"transaction_hash": resp.transaction_hash, "phone": phone_i})
    )
    print(f"OTP sent to {phone_i}. Transaction saved. Run:")
    print("  python -m bale_sidecar.debug_login verify <OTP>")
    return 0


async def cmd_verify(code: str) -> int:
    if not STATE_FILE.exists():
        print("no state — run `send <phone>` first")
        return 2
    state = json.loads(STATE_FILE.read_text())
    session_path = str(STATE_DIR / "server-session.bale")
    dp = Dispatcher()
    client = Client(dp, session_file=session_path)

    call = ValidateCode(
        code=code.strip(), transaction_hash=state["transaction_hash"]
    )
    print(f"POSTing ValidateCode with tx_hash={state['transaction_hash']!r} code={code!r}")
    try:
        content = await client.session.post(call)
    except Exception:
        print("POST raised:")
        traceback.print_exc()
        return 4

    if isinstance(content, str):
        print(f"Bale returned string response: {content!r}")
        return 5

    print(f"Bale returned {len(content)} bytes. Hex (first 256): {content[:256].hex()}")
    try:
        RAW_FILE.write_bytes(content)
        print(f"raw bytes saved to {RAW_FILE}")
    except Exception:
        traceback.print_exc()

    # Write session content like aiobale does, even if parse fails.
    session_file = Path(session_path)
    session_file.parent.mkdir(parents=True, exist_ok=True)
    session_file.write_bytes(content)
    print(f"session file written to {session_file} (raw, pre-parse)")

    # Now try to parse, but show the FULL traceback — not just the wrapped message.
    print("\n--- parse attempt ---")
    try:
        model = client._parse_session_content(content)
        print(f"parse OK: jwt.value={model.jwt.value[:40]}... user.id={getattr(model.user, 'id', '?')}")
        STATE_FILE.unlink(missing_ok=True)
        return 0
    except Exception:
        print("parse FAILED. Full traceback:")
        traceback.print_exc()
        print("\nThe session file is still saved. Whether the app can use it depends on what's missing.")
        return 6


def main() -> int:
    parser = argparse.ArgumentParser(prog="bale_sidecar.debug_login")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("send")
    p1.add_argument("phone")
    p2 = sub.add_parser("verify")
    p2.add_argument("code")
    args = parser.parse_args()
    if args.cmd == "send":
        return asyncio.run(cmd_send(args.phone))
    if args.cmd == "verify":
        return asyncio.run(cmd_verify(args.code))
    parser.error(f"unknown {args.cmd}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
