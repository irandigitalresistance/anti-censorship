from __future__ import annotations

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(prog="bale-sidecar")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_login = sub.add_parser("login", help="Interactive phone+OTP login; writes a session file.")
    p_login.add_argument("--session", default="./session.bale")

    p_run = sub.add_parser("run", help="Headless sidecar (stdin/stdout JSON-lines IPC).")
    p_run.add_argument("--session", default="./session.bale")

    args = parser.parse_args()

    if args.cmd == "login":
        from .login import run_login

        return run_login(session_path=args.session)
    if args.cmd == "run":
        from .run import run_sidecar

        return run_sidecar(session_path=args.session)
    parser.error(f"unknown cmd {args.cmd}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
