from __future__ import annotations

from aiobale import Client, Dispatcher


def run_login(*, session_path: str) -> int:
    """Triggers aiobale's built-in interactive PhoneLoginCLI (phone + OTP + optional 2FA).

    Prints progress to stdout. On success, `session_path` holds the JWT; re-running
    the sidecar with `--session <path>` will skip login. Use `--session new` to force
    a fresh login.
    """
    dp = Dispatcher()
    client = Client(dp, session_file=session_path)
    # client.run() blocks until Ctrl-C; we want it to run just long enough to
    # persist the session, so we register a post-start hook that signals us.
    import asyncio

    async def _do_login() -> None:
        try:
            await client.start()
        finally:
            try:
                await client.stop()
            except Exception:
                pass

    asyncio.run(_do_login())
    print(f"[login] session written to {session_path}")
    return 0
