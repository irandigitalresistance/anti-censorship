# bale-sidecar

Python sidecar the Node server spawns to talk to Bale Messenger as a logged-in
user account. Wraps [aiobale](https://github.com/Enalite/aiobale) and exposes a
tiny line-delimited JSON protocol on stdin/stdout.

## Install

```bash
cd server/py
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

## One-time login

aiobale persists its JWT in a `.bale` file. Run the interactive login once:

```bash
python -m bale_sidecar login --session ./session.bale
# enter phone, OTP, (2FA password if set)
```

Re-run with `--session new` to force a fresh login.

## Run as sidecar (headless)

```bash
python -m bale_sidecar run --session ./session.bale
```

Accepts line-delimited JSON on stdin, emits line-delimited JSON on stdout.

### Commands (stdin → sidecar)

```json
{"op": "send_message", "req_id": 1, "chat_id": 123, "chat_type": "PRIVATE", "text": "hello"}
{"op": "load_dialogs", "req_id": 2, "limit": 40}
{"op": "shutdown"}
```

### Events (sidecar → stdout)

```json
{"op": "ready", "me": {"id": 1517881924, "name": "...", "phone": "..."}}
{"op": "response", "req_id": 1, "ok": true, "data": {"message_id": 99999}}
{"op": "response", "req_id": 2, "ok": false, "error": "..."}
{"op": "event", "kind": "message", "chat": {"id": 123, "type": "PRIVATE"}, "sender_id": 456, "text": "...", "message_id": 789, "date": 1776000000000}
{"op": "error", "error": "..."}
```
