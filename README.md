# anti-censorship

A circumvention tunnel that smuggles arbitrary TCP/UDP traffic through messages
exchanged on the **Bale** messenger (an Iranian chat app that is not blocked
inside the censored region). A user inside the firewall runs a small client
app, the operator runs a server outside the firewall on their own VPS, and
their two Bale accounts talk to each other to move bytes — to the network it
just looks like two friends chatting.

The actual code lives under [`web-tunnel/`](./web-tunnel) as a pnpm monorepo.

## How it works (one-paragraph version)

Each side has a Bale account. The client opens a local **SOCKS5 proxy** on
`127.0.0.1:1080`. When an app connects to that proxy, the client wraps the
target address into a framed packet, encrypts it with a key derived from a
**shared password** (scrypt → AEAD), splits it into chat-message-sized chunks,
and *sends them as Bale messages* to the server's account. The server's Bale
account receives the chunks, the dispatcher reassembles and decrypts them,
opens a real TCP/UDP connection to the destination, and proxies bytes back the
same way. To Bale (and to anyone watching the network) it's two ordinary
accounts trading text.

```
   ┌──────────────┐    SOCKS5     ┌──────────────┐
   │  user's app  │ ────────────▶ │ client app   │
   └──────────────┘               │ (Electron /  │
                                  │  Android)    │
                                  └──────┬───────┘
                                         │ encrypted, framed
                                         ▼ chat messages
                                  ┌──────────────┐
                                  │ Bale servers │  ← looks like normal chat
                                  └──────┬───────┘
                                         │
                                  ┌──────▼───────┐
                                  │ server (Node │
                                  │  + Python    │
                                  │  Bale sidecar)│
                                  └──────┬───────┘
                                         │ real TCP/UDP
                                         ▼
                                    open internet
```

## Repository layout

Everything operational is inside [`web-tunnel/`](./web-tunnel). The pnpm
workspace defines six packages plus two app shells:

| Path | What it is |
|---|---|
| `web-tunnel/shared/` | Protocol primitives shared by every component: framing, AEAD handshake (PSK + Noble crypto), stream multiplexer (`mux`, `mux-v2`), Bale gRPC-Web client, LiveKit transport, mocks. |
| `web-tunnel/client/` | Headless Node client. Opens the local SOCKS5 listener and runs the tunnel over a `Transport` (WebSocket loopback for dev, Bale chat in prod). |
| `web-tunnel/server/` | Headless Node server. Accepts tunnels, multiplexes streams, egresses to the real internet, hosts the loopback dashboard on `:4402`. |
| `web-tunnel/server/py/` | Python "Bale sidecar" (`bale_sidecar`). Wraps the unofficial Bale gRPC API; handles login (phone → OTP → JWT) and message I/O for the server. |
| `web-tunnel/client-electron/` | Windows desktop app. Wraps the client in Electron + a small UI for phone login, chat-picker, and Start/Stop. Builds to `WebTunnel-Client.exe`. |
| `web-tunnel/server-electron/` | Same idea for the operator's server (one-binary install on Windows VPS). |
| `web-tunnel/client-android/` | Native Android client (Kotlin). VPN-service mode using `hev-socks5-tunnel` to capture all device traffic into the SOCKS5 proxy. |
| `web-tunnel/probe/` | Throwaway scripts and end-to-end probes used during development (network captures, WebRTC sanity checks). |

## Protocol, in layers

1. **Carrier.** Whatever bidirectional message bus is available to a pair of
   Bale accounts: the chat itself (low throughput, ~5–30 KB/s, always works),
   or a LiveKit WebRTC room created via Bale's `Meet/StartCall` RPC (high
   throughput, built and tested against mocks but not fully wired in v1).
2. **Magic envelope.** Every payload begins with a 4-byte magic
   (`__WT_REQ__`, `__WT_OK__`, `__WT_FRAME__`, …) so the receiver can tell
   tunnel traffic apart from real chat messages and ignore the rest.
3. **Handshake.** PSK is `scrypt(password, salt)`. The client sends an
   ECDH ephemeral key inside an AEAD-sealed `__WT_REQ__`; the server replies
   with `__WT_OK__` containing its own ephemeral key. After that, both sides
   share a session key. (V2 adds server identity verification + a denial frame
   so wrong passwords fail loudly instead of hanging.)
4. **Frame.** A varint-length opcode + payload (`OPEN`, `DATA`, `CLOSE`,
   `WINDOW`, …) chunked to fit the carrier's max-message size.
5. **Mux.** Many logical streams (one per SOCKS connection) ride a single
   tunnel, identified by stream IDs with per-stream flow control. V2 adds
   per-frame LZ4 compression and a UDP flow type for things like DNS.

## Safety, encryption, and what Bale can see

The whole design assumes Bale itself is **not trusted** — they run the
servers your messages flow through, they can read every chat, and they
co-operate with the regulator. So everything sensitive is sealed before it
ever touches a Bale API call. The only thing Bale handles is opaque ciphertext
wrapped in a magic prefix.

### Key derivation and handshake

Implemented in [`shared/src/handshake.ts`](./web-tunnel/shared/src/handshake.ts)
and [`handshake-v2.ts`](./web-tunnel/shared/src/handshake-v2.ts), all using
audited primitives from `@noble/ciphers`, `@noble/curves`, and
`@noble/hashes`.

- **PSK from password.** `scrypt(password, salt, N=2¹⁵, r=8, p=1) → 32-byte key`.
  scrypt's memory-hardness makes the password expensive to brute-force even
  with a leaked transcript.
- **v1 handshake (chat carrier).** Client sends `clientNonce ‖ HMAC-SHA256(psk, "WT-REQ" ‖ clientNonce)`,
  server replies with `serverNonce ‖ HMAC-SHA256(psk, "WT-OK" ‖ clientNonce ‖ serverNonce)`.
  Both sides then derive the session key with
  `HKDF-SHA256(psk ‖ clientNonce ‖ serverNonce, "web-tunnel session v0") → 32 bytes`.
- **v2 handshake (with server identity).** Server has a long-lived **Ed25519**
  identity key. Each side generates a fresh **X25519** ephemeral, exchanges
  it, and the server signs the full transcript with Ed25519. The client gets
  a server **fingerprint** it can pin, so a Bale operator who tampers with
  messages can't silently MITM a future session. Forward secrecy comes from
  the ephemeral X25519 share — even if the long-term password leaks later,
  past sessions stay sealed.

### Session encryption (the bytes Bale actually carries)

Every payload (`OPEN`, `DATA`, `CLOSE`, `WINDOW`, …) is encrypted with
**XChaCha20-Poly1305** AEAD: 32-byte session key, fresh 24-byte random
nonce per message, 16-byte Poly1305 authentication tag. So Bale only ever
gets `nonce ‖ ciphertext ‖ tag`. They cannot:

- read the destination hostname, port, or any plaintext bytes,
- alter even one byte without the AEAD tag failing on the other side,
- replay an old message in a new session (different session key, different
  nonces; mux frames also carry stream IDs and sequence info).

### Wire format on the chat

A chat message looks like this:

```
__WT_FRAME__<sessionTag>.<base64url(ciphertext)>
```

- The **magic prefix** (`__WT_REQ__`, `__WT_OK__`, `__WT_DENY__`,
  `__WT_FRAME__`, `__WT2_FRAME__`, `__WT_MEET__`) tells the dispatcher this is
  tunnel traffic. Anything without it is treated as a real chat message and
  ignored. Defined in [`shared/src/magic.ts`](./web-tunnel/shared/src/magic.ts).
- The optional **session tag** lets one Bale chat carry several concurrent
  client tunnels without crosstalk.
- The **base64url** part is just the AEAD ciphertext — no headers, no
  recognisable protocol bytes inside.

This is honest about what it is: it does **not** try to look like normal chat
("steganography"). It looks like a bot trading opaque tokens. The hiding power
is "Bale won't single this out among millions of chats", not "this is
indistinguishable from a love letter". A motivated platform-side classifier
that flags long base64-looking messages on a single account would catch it —
which is why the docs insist on a throwaway server account and the `v2`
roadmap includes the LiveKit/WebRTC carrier where the bytes ride a real audio
call instead of chat messages.

### Local secrets

- **Password.** Lives in `WT_PASSWORD` env var on both sides. Never written to
  disk, never sent to Bale (only its scrypt-derived key is used, and only
  inside HMAC/HKDF — the PSK itself never goes on the wire).
- **Bale session JWT.** Stored at `~/.webtunnel/server-session.bale` (server)
  or in the OS keychain via Electron `safeStorage` (desktop client) — same
  trust level as your normal Bale login.
- **Server identity key (v2).** Lives next to the server config; rotating it
  invalidates pinned client fingerprints, same as an SSH host key.

### Threats this design does *not* defeat

- **Traffic analysis at the ISP.** TLS to Bale's servers is fine, but the
  *pattern* (constant chat with one contact, message sizes, inter-arrival
  times) is visible to anyone watching the link. A determined adversary doing
  on-path classification could spot it.
- **Bale account ban.** Bale can detect the high message rate on the server
  account and disable it. The design assumes accounts are cheap to replace.
- **Endpoint compromise.** If the client device is rooted or the server VPS is
  taken over, all the crypto in the world doesn't help.
- **Quantum.** No post-quantum primitives in v1. Anything Bale records today
  could be decrypted later with a sufficiently powerful quantum computer
  (roughly 10–20 years out by current public estimates).

## Running it

The full operator and end-user guides already live next to the code:

- **Server operator:** [`web-tunnel/server/SERVER-SETUP.md`](./web-tunnel/server/SERVER-SETUP.md)
  — VPS install, Bale login, systemd unit, dashboard SSH-tunnel.
- **End user (Windows):** [`web-tunnel/client-electron/CLIENT-SETUP.md`](./web-tunnel/client-electron/CLIENT-SETUP.md)
  — extract zip, log into Bale, pick the operator's chat, paste shared password,
  point apps at SOCKS5 `127.0.0.1:1080`.

Quick local development loop (no Bale account needed — uses the loopback
WebSocket transport and mocks):

```bash
cd web-tunnel
pnpm install
pnpm -r test       # framing, handshake, mux, SOCKS5, dashboard, dispatcher
pnpm -r typecheck
```

Building release binaries:

```bash
pnpm release:windows    # both client and server .exe
pnpm release:android    # signed APK via Gradle
```

## Threat model and limits (v1)

- **Authentication is a shared password.** Anyone who knows it gets a tunnel.
  No per-client approval inbox yet.
- **Bale account hygiene.** Use a dedicated throwaway account on the server
  side — heavy framed traffic looks abnormal and risks an account ban.
- **Throughput** in chat-only mode is bounded by Bale's per-account message
  rate (~3 msg/sec → 5–30 KB/s). The LiveKit/WebRTC carrier is designed to
  blow past that ceiling but the call-start glue on the server is still TODO.
- **Wrong-password handshakes hang silently** in v1; V2 adds an explicit deny.
- **Code-signing.** Windows binaries are unsigned, so SmartScreen will warn
  on first run.

## License

Vendored third-party code keeps its original license (e.g.
`HEV-SOCKS5-TUNNEL-LICENSE.txt` in `client-android/`). Project license: TBD.
