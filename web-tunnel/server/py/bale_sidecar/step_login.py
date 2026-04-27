"""Non-interactive stepped login. Splits aiobale's login into three subcommands
so it can be driven from a tool that can't supply a real TTY for input().

Usage:
  python -m bale_sidecar.step_login send-code    <phone>    --session <path>
  python -m bale_sidecar.step_login verify-code  <otp>      --session <path>
  python -m bale_sidecar.step_login verify-password <pass>  --session <path>

State between calls (the transaction_hash) is kept in
`~/.webtunnel/step-login-state.json`.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from aiobale import Client, Dispatcher
from aiobale.enums import AuthErrors, SendCodeType

STATE_DIR = Path(os.path.expanduser("~/.webtunnel"))
STATE_FILE = STATE_DIR / "step-login-state.json"


def _state_write(obj: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(obj))


def _state_read() -> dict:
    if not STATE_FILE.exists():
        raise SystemExit(
            f"state file missing at {STATE_FILE}; run `send-code` first"
        )
    return json.loads(STATE_FILE.read_text())


async def cmd_send_code(phone: str, session: str) -> int:
    dp = Dispatcher()
    client = Client(dp, session_file=session)
    try:
        phone_int = int(phone.replace("+", "").strip())
    except ValueError:
        print(f"invalid phone {phone!r}", file=sys.stderr)
        return 2
    resp = await client.start_phone_auth(
        phone_number=phone_int, code_type=SendCodeType.DEFAULT
    )
    if isinstance(resp, AuthErrors):
        print(f"start_phone_auth failed: {resp!r}", file=sys.stderr)
        return 3
    _state_write(
        {"transaction_hash": resp.transaction_hash, "phone": phone_int}
    )
    print(
        f"OTP dispatched to {phone_int}. Transaction hash saved to "
        f"{STATE_FILE}."
    )
    print(
        f"Next: python -m bale_sidecar.step_login verify-code <OTP> --session {session}"
    )
    return 0


async def cmd_verify_code(code: str, session: str) -> int:
    state = _state_read()
    dp = Dispatcher()
    client = Client(dp, session_file=session)
    res = await client.validate_code(code.strip(), state["transaction_hash"])
    if res == AuthErrors.WRONG_CODE:
        print("incorrect OTP", file=sys.stderr)
        return 4
    if res == AuthErrors.PASSWORD_NEEDED:
        print(
            "2FA password required. Next: python -m bale_sidecar.step_login "
            f"verify-password <PASSWORD> --session {session}"
        )
        return 10  # sentinel so caller knows 2FA is needed
    if res == AuthErrors.SIGN_UP_NEEDED:
        print(
            "account not registered — sign up using the official Bale app "
            "first, then retry.",
            file=sys.stderr,
        )
        return 5
    if isinstance(res, AuthErrors):
        print(f"validate_code failed: {res!r}", file=sys.stderr)
        return 6
    # Success: session file is written by aiobale internally.
    print(f"login complete. Session written to {session}.")
    if STATE_FILE.exists():
        STATE_FILE.unlink()
    return 0


async def cmd_verify_password(password: str, session: str) -> int:
    state = _state_read()
    dp = Dispatcher()
    client = Client(dp, session_file=session)
    res = await client.validate_password(password, state["transaction_hash"])
    if isinstance(res, AuthErrors):
        print(f"validate_password failed: {res!r}", file=sys.stderr)
        return 7
    print(f"login complete (with 2FA). Session written to {session}.")
    if STATE_FILE.exists():
        STATE_FILE.unlink()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="bale_sidecar.step_login")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("send-code")
    p1.add_argument("phone")
    p1.add_argument("--session", required=True)

    p2 = sub.add_parser("verify-code")
    p2.add_argument("code")
    p2.add_argument("--session", required=True)

    p3 = sub.add_parser("verify-password")
    p3.add_argument("password")
    p3.add_argument("--session", required=True)

    args = parser.parse_args()
    if args.cmd == "send-code":
        return asyncio.run(cmd_send_code(args.phone, args.session))
    if args.cmd == "verify-code":
        return asyncio.run(cmd_verify_code(args.code, args.session))
    if args.cmd == "verify-password":
        return asyncio.run(cmd_verify_password(args.password, args.session))
    parser.error(f"unknown cmd {args.cmd}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
