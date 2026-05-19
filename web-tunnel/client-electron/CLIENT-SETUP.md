# NovaNet — Client setup (Windows)

NovaNet 0.4.2. Single portable exe. No Python. No terminal. No pip. **You
never log into Bale** — you only paste a config string the operator gives you.

## Install

1. The operator sends you two things out-of-band:
   - the app: `NovaNet-Client-0.4.2.exe` (a single portable Windows x64 exe), and
   - a **client config** — one long string that starts with `wtc1:`.

   The exe is not published in the repository; the operator builds it and
   uploads/sends it to you separately.
2. Put `NovaNet-Client-0.4.2.exe` anywhere and double-click it.

The first time, Windows may warn "Windows protected your PC" /
"unrecognized app". Click *More info* → *Run anyway* — the binary is not
code-signed.

## Use

1. On the **Client config** screen, paste the operator's `wtc1:…` string into
   the box and click *Use config*.
2. Leave the **SOCKS5 port** at `1080` (change only if something else already
   uses that port), then click *Start tunnel*.
3. The app places a **Bale Meet call** to the operator's server account and
   brings the tunnel up. When the status shows the tunnel is active, point any
   app at SOCKS5 proxy `127.0.0.1:1080` — traffic now rides through the call.

There is **no phone number, no SMS code, no 2FA password, and no chat to
pick.** Importing the config is the entire setup; the Bale identity is already
inside the config.

Browser SOCKS setup (Firefox): *Settings → Network → Manual proxy → SOCKS v5
`127.0.0.1` port `1080`*, tick *Proxy DNS when using SOCKS5*.

## What you'll need from the server operator

- The `NovaNet-Client-0.4.2.exe` app file.
- The **client config** (`wtc1:…`). It is per-user and revocable — treat it
  like a password, don't share it, and import only the one meant for you.

That's all. You do not need their phone number, a username, or a shared
password.

## Sign out / switch config

Top-right *Sign out* clears the stored config and returns to the
**Client config** screen, where you can paste a new `wtc1:…` string.

## Troubleshooting

| Symptom | Try |
|---|---|
| *"Import a client config first"* | No config stored. Paste the `wtc1:…` string on the Client config screen and click *Use config*. |
| *"This client config is already connected on another device"* | The same config is in use elsewhere. The server allows one live connection per config — stop the other device, or ask the operator for a fresh config. |
| *"SOCKS port is already in use"* | Another program holds port 1080. Change the SOCKS5 port and click *Start tunnel* again. |
| Tunnel won't come up / drops | The Bale Meet call could not be established or was reset. Stop and Start again; if it persists, ask the operator to confirm the server is running and the config is still valid. |
| Windows SmartScreen blocks the exe | Unsigned build. *More info → Run anyway*. |

## What's NOT in 0.4.2

- **Code signing / auto-update.** The exe is unsigned, so Windows SmartScreen
  warns on first run, and there is no in-app updater — the operator sends a new
  exe to upgrade.
- **In-app Bale login.** By design. The Bale identity is provisioned by the
  operator and travels inside the config; the client never logs in.
- **Carrier is still beta.** The tunnel rides a Bale Meet call (a LiveKit data
  channel, or a media-video packet carrier when Bale disables data packets on
  the call). Expect occasional reconnects and call-setup hiccups.
