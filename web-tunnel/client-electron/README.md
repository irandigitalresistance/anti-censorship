# @webtunnel/client-electron

Windows-first Electron GUI for the Web Tunnel client. Wraps the Node client
(`@webtunnel/client`, `@webtunnel/shared`) and the aiobale Python sidecar
(`@webtunnel/server` → `PythonSidecar`) into a small UI with three states:
status, chat-picker, connected.

## One-time setup

Install Node deps and build TypeScript:

```
pnpm install
pnpm --filter @webtunnel/client-electron build
```

Install the Python sidecar in a venv (in the repo's `server/py/` folder) and
log in once — this writes `server/py/session.bale`:

```
cd server/py
python -m venv .venv && . .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -e .
python -m bale_sidecar login --session ./session.bale
```

## Run

```
pnpm --filter @webtunnel/client-electron dev
```

Environment overrides (all optional):

- `WT_PYTHON` — path to python (default `/usr/bin/python3`; use the venv's
  `python.exe` on Windows, e.g. `server\py\.venv\Scripts\python.exe`).
- `WT_SESSION_FILE` — absolute path to the `.bale` session file.
- `WT_SIDECAR_CWD` — where `python -m bale_sidecar run` should run from
  (default: `../server/py/` relative to this package).

## Package for Windows

```
pnpm --filter @webtunnel/client-electron dist:win
```

Outputs `client-electron/release/WebTunnel-Setup-<version>.exe` (NSIS).
Requires running on Windows (or Wine-based cross-build; not tested).

## What the app does

1. Spawns the Python sidecar with the saved Bale session.
2. Fetches the user's dialogs (`load_dialogs`) and shows them in a dropdown.
3. User picks the chat containing the server's Bale account and enters the
   shared password (same one configured on the server — the PSK is derived
   from it via scrypt).
4. Opens a `ChatTransport` to that chat, runs the PSK handshake, brings up
   the multiplexer, and starts a local SOCKS5 listener on 127.0.0.1:1080.
5. Point any app at `socks5://127.0.0.1:1080` — traffic now rides through
   `__WT_FRAME__<base64>` messages in that Bale chat.

## What it explicitly does NOT do yet

- No LiveKit/WebRTC transport (Milestone 6 built the transport and the mock,
  but the Bale-side call-start RPC is not wired into aiobale yet).
- No in-app Bale login (Milestone 8b). Login is a one-shot terminal step.
- No auto-update / code signing.
