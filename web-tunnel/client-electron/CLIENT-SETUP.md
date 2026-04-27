# Web Tunnel — Client setup (Windows)

Single zip, single exe. No Python. No terminal. No pip.

## Install

1. Extract `WebTunnel-Windows-x64-0.0.1.tar.gz` anywhere (7-Zip opens `.tar.gz` directly). You'll get a `win-unpacked\` folder.
2. Double-click `win-unpacked\Web Tunnel.exe`.

The first time Windows may warn "unrecognized app". Click *More info* → *Run anyway* (the binary isn't code-signed).

## Use

1. **Enter your phone number** (international format, no `+`, e.g. `989123456789`) and click *Send code*.
2. **Enter the OTP** Bale texts you, click *Verify*.
3. (If your account has a 2FA password, enter it when prompted.)
4. Your chat list loads. Pick the chat with the server operator's Bale account.
5. Enter the **shared password** the server operator gave you. Click *Start tunnel*.
6. Point any app at SOCKS5 proxy `127.0.0.1:1080` — traffic now rides through Bale.

Browser SOCKS setup (Firefox): *Settings → Network → Manual proxy → SOCKS v5 127.0.0.1:1080*, tick *Proxy DNS when using SOCKS5*.

## What you'll need from the server operator

- Their **Bale phone number** (so the chat appears in your list — add them as a contact first if needed).
- The **shared password** they've configured on their side.

## Sign out / switch account

Top-right *Sign out* clears the saved session and returns to the phone-entry screen.

## Troubleshooting

| Symptom | Try |
|---|---|
| *"phone auth limit exceeded"* on send-code | You've hit Bale's OTP rate limit for your number. Wait ~10 min. |
| *"wrong code"* | OTP typed wrong or expired. Click *Send code* again to get a fresh one. |
| Chat list empty | Open Bale on your phone and chat with at least one person. Then re-open this app. |
| *"handshake failed"* after Start tunnel | Shared-password mismatch with the server. Ask the operator to confirm theirs. |
| Windows SmartScreen blocks the exe | Unsigned build. *More info → Run anyway*. For a proper signed installer, the operator needs to build on Windows with a code-signing cert. |

## What's NOT in v1

- **Real-time message streaming.** This v1 polls every ~1.2s for new messages. Functional but adds latency; expect roughly 1-2s round-trip on small HTTP requests. A Session 2 release will replace polling with Bale's WebSocket-RPC push.
- **LiveKit/WebRTC transport.** Chat-only for now. The WebRTC path (high throughput) is built and tested against mocks but not yet wired to Bale's call-start RPC.
- **Code signing.** The exe is unsigned; Windows SmartScreen will warn.
