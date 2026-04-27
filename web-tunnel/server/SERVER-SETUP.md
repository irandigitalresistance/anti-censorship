# Web Tunnel — Server setup

You (the operator) run this on a box that **has open internet access** (outside the
censored region). Clients route their traffic to you by messaging your Bale
account; you egress to the real internet on their behalf.

## 0. What you need

- A Linux VPS (or any machine) with:
  - **Open internet access.** The whole point is that clients can't reach the
    open internet directly — you're their exit.
  - **Node.js 20+** and **Python 3.10+**.
  - No inbound firewall ports need opening. All traffic rides on Bale's
    existing TLS, outbound from your box. Dashboard is localhost-only by default.
- A **dedicated Bale account** for the server. Fresh throwaway account is best —
  heavy framing traffic looks abnormal and could get it banned.
- A **shared password**, long and random. This is the key your clients need;
  anyone with it can use the tunnel. Treat it like WiFi: you hand the same
  string to everyone who should have access.

## 1. Clone + install (one-time)

On the server box:

```bash
# Node deps
cd /opt
git clone <your-repo> web-tunnel   # or scp the project over
cd web-tunnel
pnpm install

# Python sidecar
cd server/py
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
```

## 2. Log into Bale (one-time)

Still in `server/py/` with venv activated:

```bash
python -m bale_sidecar login --session "$HOME/.webtunnel/server-session.bale"
```

It'll prompt for: phone number → OTP from SMS → (optional 2FA password). On
success, it writes the JWT to `~/.webtunnel/server-session.bale`. The server
reuses this file on every start; no more prompts.

**Use the throwaway account.** Do not log in with your personal Bale.

## 3. Run the server

```bash
cd /opt/web-tunnel
WT_PASSWORD='some-long-shared-secret-you-give-clients' \
  pnpm --filter @webtunnel/server bale
```

You should see:

```
[server] dashboard on http://127.0.0.1:4402/
[server] spawning Bale sidecar (python=…, session=…)
[server] logged in as <your-name> (id=…)
[server] ready. Clients who know the shared password can now open tunnels…
[dispatch] dispatcher started
```

The server is now listening for messages on your Bale account. When a client
sends a `__WT_FRAME__` packet, the dispatcher auto-spawns a tunnel (if they
know the password, the PSK handshake succeeds; otherwise the tunnel is
dropped silently).

## 4. Watch tunnels

SSH-tunnel the dashboard to your laptop:

```bash
# on your laptop:
ssh -L 4402:127.0.0.1:4402 user@your-server
# then open in your browser:
#   http://localhost:4402/
```

You'll see each active client tunnel, their bytes up/down, and a live
sparkline of throughput per tunnel.

## 5. Run it in the background

Easy: **tmux**.

```bash
tmux new -s webtunnel
# paste the WT_PASSWORD=... pnpm ... command
# detach with Ctrl-b d
```

Better: **systemd unit**. Create `/etc/systemd/system/webtunnel.service`:

```ini
[Unit]
Description=Web Tunnel server
After=network.target

[Service]
Type=simple
User=webtunnel
WorkingDirectory=/opt/web-tunnel
Environment=WT_PASSWORD=your-long-secret
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/webtunnel/.nvm/versions/node/v20.18.0/bin
ExecStart=/bin/bash -lc 'pnpm --filter @webtunnel/server bale'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webtunnel
journalctl -u webtunnel -f
```

## 6. Give clients their credentials

Hand each client:

1. The archive: `client-electron/release/WebTunnel-Windows-x64-0.0.1.tar.gz`
2. The guide: `client-electron/CLIENT-SETUP.md`
3. Two strings:
   - `WT_PASSWORD` — **the same value** you put in the server's environment.
   - Your server's Bale contact (phone number or @username). They add it as a
     contact so it shows up in their chat list.

They log in on their own Bale account, pick the chat with yours, enter the
password, hit Start. That's it — traffic flows through you.

## Environment variables

All optional; defaults usually fine.

| Var | Default | Meaning |
|---|---|---|
| `WT_PASSWORD` | *(required)* | Shared secret; PSK derived via scrypt. |
| `WT_SESSION_FILE` | `~/.webtunnel/server-session.bale` | Bale session file. |
| `WT_PYTHON` | auto (venv or `python3`) | Python executable. |
| `WT_SIDECAR_CWD` | `server/py` | Where to run the sidecar from. |
| `WT_DASHBOARD_PORT` | `4402` | Local dashboard port. |
| `WT_DASHBOARD_HOST` | `127.0.0.1` | Dashboard bind host (keep to loopback; SSH-tunnel it). |

## Tests you can run to sanity-check without Bale

```bash
pnpm -r test
```

The suite covers: framing, handshake, mux, SOCKS5, chat transport over a mock
Bale bus, LiveKit transport over a mock LiveKit bus, dashboard event stream,
and the Bale server dispatcher with two concurrent mock clients.

## Known limits of v1

- **No approval inbox yet.** Anyone with the password completes the handshake
  and gets a tunnel. If you want per-client approval ("Alice wants in — allow?")
  that's a dashboard feature we haven't wired.
- **Rate-limit risk.** Bale throttles accounts that send/receive too many
  messages outside auth. ChatTransport messages are ~3/sec ceiling-ish; real
  throughput is 5–30 KB/s.
- **No LiveKit mode in the server binary.** The WebRTC data-channel transport
  is built and tested in shared/, but the aiobale glue to call
  `bale.meet.v1.Meet/StartCall` + `Meet/GetWssURL` is still a TODO.
- **No message acking / resend.** If Bale drops a chat message mid-stream the
  tunnel stalls. Usually rare on private chats.
- **Wrong-PSK handshakes hang the client silently.** V2 will send
  `__WT_DENY__` so clients fail fast.
