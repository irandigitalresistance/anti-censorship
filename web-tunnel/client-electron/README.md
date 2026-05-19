# @webtunnel/client-electron

**NovaNet** Windows client (package `@webtunnel/client-electron`, version
0.4.2). Windows-first Electron GUI for the Web Tunnel client. Wraps the Node client
(`@webtunnel/client`, `@webtunnel/shared`) and the native Bale client into a
small UI with three states: status, config, connected.

## One-time setup

Install Node deps and build TypeScript:

```
pnpm install
pnpm --filter @webtunnel/client-electron build
```

## Run

```
pnpm --filter @webtunnel/client-electron dev
```

Environment overrides are optional:

- `WT_SESSION_FILE` - absolute path to the saved Bale session file.

## Package for Windows

```
pnpm --filter @webtunnel/client-electron dist:win
```

Outputs the portable `release/NovaNet-Client-0.4.2.exe` (single unsigned exe,
no installer). Requires running on Windows or a working cross-build setup. The
artifact is git-ignored and distributed out-of-band, not committed.

## What the app does

1. Loads the imported server config.
2. Starts a Bale Meet call to the server account.
3. Runs the tunnel over the LiveKit carrier for that Meet room (a data
   channel, or a media-video packet carrier when Bale disables data packets),
   brings up the multiplexer, and starts a local SOCKS5 listener on
   127.0.0.1:1080.
4. Point any app at `socks5://127.0.0.1:1080` and traffic rides through the
   Bale Meet connection.

## What it explicitly does NOT do yet

- No in-app Bale login. Login is handled through saved/imported session data.
- No auto-update / code signing.
