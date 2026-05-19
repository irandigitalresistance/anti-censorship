# NovaNet

**NovaNet 0.4.2** — a circumvention tunnel that smuggles arbitrary TCP/UDP
traffic through the **Bale** messenger (an Iranian chat app that is not blocked
inside the censored region). "NovaNet" is the product name carried by the
shipped apps (Windows client/server and Android client); the repository and the
internal pnpm packages are still named `web-tunnel`.

The operator runs a server outside the firewall on their own VPS and
**logs in both Bale accounts there** — the server's own account *and* a client
account they provision on the end user's behalf. The end user inside the
firewall runs a small client app and only ever imports an operator-issued
config blob; they never log into Bale, never enter a phone number, never
receive an OTP. The two operator-controlled Bale identities talk to each other
to move bytes — to the network it just looks like two accounts on a call.

Keeping the client's Bale credentials on the server (not on the end user's
device, and never created by the end user) is a deliberate **safety choice**:
the person being protected never ties their real phone number or personal Bale
account to circumvention traffic, and a burned tunnel account is the
operator's throwaway, not theirs. See
[Account model](#account-model-the-server-holds-both-bale-identities) below.

The actual code lives under [`web-tunnel/`](./web-tunnel) as a pnpm monorepo.

## How it works (one-paragraph version)

The operator logs in two Bale accounts on the server and, for each end user,
generates an **encrypted client config** — a `wtc1:…` blob that carries the
client account's Bale session plus the server's address and pinned identity.
The end user imports that single string into the client app; that's the entire
"login". The client app loads the embedded Bale session, places a Bale **Meet
call** to the server account, and the two accounts join the call's
LiveKit/WebRTC session.

> **The platform blocked the data-channel path.** Bale's LiveKit deployment
> disables WebRTC data-channel publishing on Meet calls (the LiveKit
> participant permission `canPublishData=false`, or the data channel is
> otherwise dropped). NovaNet 0.4.2 therefore **does not rely on the data
> channel**: it carries tunnel packets over the **Meet media connection**
> instead, by publishing a synthetic media (video) track whose frames are
> just the tunnel's packets. This is **not** video steganography — nothing is
> hidden inside a real picture; the media track *is* the packet carrier.

The client opens a local **SOCKS5 proxy** on `127.0.0.1:1080`; when an app
connects, the client wraps the target address into a framed packet, encrypts
it (AEAD, with the server's identity pinned from the config), and sends it as
payload on the Meet media connection. The server side reassembles and
decrypts, opens a real TCP/UDP connection to the destination, and proxies bytes
back the same way. To Bale (and anyone watching the network) it looks like two
accounts on an ordinary voice/video call.

```
   operator's machine, outside the firewall
   ┌───────────────────────────────────────────────┐
   │ server: runs BOTH Bale accounts                │
   │   • server account  (the exit node)            │
   │   • client account  (provisioned for the user) │
   │ mints  ┌───────────────────────────────┐       │
   │ ─────▶ │ encrypted client config (wtc1:)│       │
   │        └───────────────┬───────────────┘       │
   └────────────────────────┼───────────────────────┘
                            │ handed to the user out-of-band
                            ▼ (no Bale login on the user's side)
   ┌──────────────┐  SOCKS5  ┌──────────────┐
   │  user's app  │ ───────▶ │ client app   │  loads the embedded
   └──────────────┘          │ (Electron /  │  client Bale session
                             │  Android)    │
                             └──────┬───────┘
                                    │ Bale Meet call →
                                    ▼ tunnel packets on the Meet
                                    ▼ media connection (data channel
                                    ▼ blocked by the platform)
                             ┌──────────────┐
                             │ Bale servers │ ← looks like a voice call
                             └──────┬───────┘  between two accounts
                                    │
                             ┌──────▼───────┐
                             │ server side  │ decrypts, egresses
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
| `web-tunnel/shared/` | Protocol primitives shared by every component: framing, AEAD handshake (PSK + Noble crypto), stream multiplexer (`mux`, `mux-v2`), Bale gRPC-Web client, LiveKit transport, the Bale Meet factory, the media-video packet carrier (`media-video-carrier`/`media-video-codec`), mocks. |
| `web-tunnel/client/` | Headless Node client. Opens the local SOCKS5 listener and runs the tunnel over a `Transport` (WebSocket loopback for dev, Bale Meet/WebRTC in prod). |
| `web-tunnel/server/` | Headless Node server. Accepts tunnels, multiplexes streams, egresses to the real internet, hosts the loopback dashboard on `:4402`. |
| `web-tunnel/server/py/` | Python "Bale sidecar" (`bale_sidecar`). Wraps the unofficial Bale gRPC API; handles login (phone → OTP → JWT) and message I/O. (`server-electron` uses an in-process native TS sidecar instead.) |
| `web-tunnel/shared/src/client-config.ts` | The `wtc1:` client config: AES-GCM packing of the client Bale session + server peer + server UUID + pinned fingerprint. Encoded on the server, decoded by every client app. |
| `web-tunnel/client-electron/` | **NovaNet** Windows desktop client. Wraps the client in Electron. No Bale login UI — the user pastes the operator-issued config and hits Start/Stop. Builds to the portable `NovaNet-Client-0.4.2.exe`. |
| `web-tunnel/server-electron/` | **NovaNet Server** — the operator's server (one-binary install on a Windows VPS; a macOS zip target also exists). Logs in **both** Bale accounts, mints per-user client configs, runs the dashboard. Builds to `NovaNet-Server-0.4.2.exe`. |
| `web-tunnel/client-android/` | Native **NovaNet** Android client (Kotlin). Imports the operator-issued config; VPN-service mode using `hev-socks5-tunnel` to capture all device traffic into the SOCKS5 proxy. |
| `web-tunnel/probe/` | Throwaway scripts and end-to-end probes used during development (network captures, WebRTC sanity checks). |

## Protocol, in layers

1. **Carrier (Meet media connection).** A bidirectional byte channel between
   the operator's two Bale accounts, carried by a **Bale Meet call**. There is
   no longer a chat-message carrier — the old `chat-transport` was removed in
   0.4.2, so all clients use the Meet path. The client app places a Meet call
   to the server account via Bale's `Meet/StartCall` RPC, the server's
   incoming-call watcher accepts it, and both join the same room on **Bale's
   own LiveKit SFU** (`wss://meet-*.ble.ir/rtc`, which is whitelisted inside
   the region).

   **The data-channel transport is blocked by the platform.** Bale's LiveKit
   deployment sets the participant permission `canPublishData=false` (or
   otherwise refuses/drops data-channel publishing) on Meet calls, so a WebRTC
   data channel cannot be used as the carrier. NovaNet 0.4.2 therefore sends
   **tunnel packets over the Meet media connection instead**: it publishes a
   synthetic LiveKit media (video) track (`wt-media-packets`) and uses each
   frame as a packet container, with its own ACK/retransmit on top
   (`shared/src/bale/media-video-carrier.ts` on Node,
   `MediaVideoTransport.kt` on Android), wired end-to-end in
   `server-electron`/`client-electron`/`client-android`. To be explicit: this
   is **packet carriage over the media connection**, not video
   steganography — the tunnel does not hide bytes inside a real camera
   picture; the synthetic track's frame bytes simply *are* the packets. (The
   code still prefers a data channel if the platform ever grants one, but in
   practice the media path is what runs.) This path is still beta — expect
   reconnects and retransmits.
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

### Account model: the server holds both Bale identities

The most important safety property is *who* holds the Bale credentials. The
**operator runs the server outside the firewall and logs in two Bale accounts
there**:

- the **server account** — the exit node's Bale identity, and
- a **client account** — a Bale account the operator registers and provisions
  *on behalf of the end user*.

The end user never logs into Bale. In the server UI the operator creates a
named client profile, and the server emits an **encrypted client config**
(`encodeClientConfig` in
[`shared/src/client-config.ts`](./web-tunnel/shared/src/client-config.ts)) — a
single `wtc1:…` string that packs:

- the client account's Bale session (`jwt`, `userId`, `userName`,
  `userAccessHash`),
- the server peer to call (`chatId`, `chatType`, label),
- the server's `serverUuid` and pinned Ed25519 `serverFingerprint`,
- the carrier (`webrtc`) and default SOCKS port,
- a per-config `clientId`.

The operator hands that one string to the end user out-of-band. The client app
(Windows or Android) calls `decodeClientConfig`, loads the embedded Bale
session, and runs the tunnel. There is **no phone-number entry, no OTP, no
chat-picker, no shared password to type** on the user's side — importing the
blob is the entire setup.

**Why this protects the end user.** The person inside the censored region is
the one at risk. With this model:

- Their **real phone number and personal Bale account are never used** and
  never linked to circumvention traffic. The account that does the tunnelling
  is a throwaway the operator created.
- They never have to **perform a Bale OTP login on a monitored network** —
  that login (SMS, phone entry, new-device registration on a fresh account) is
  itself a signal, and it happens on the operator's side instead.
- If Bale flags and bans the tunnelling account, the **operator** absorbs that
  — the end user just gets a new config. Account bans are expected and cheap.
- The credential is **per-user and revocable**: the server keys connections by
  the embedded `clientId`, refuses unknown ids (`CONFIG_UNKNOWN_CLIENT`) and
  refuses a second concurrent use of the same id (`CONFIG_ALREADY_CONNECTED`).
  Deleting the client profile on the server instantly cuts that user off
  without touching anyone else.

**Honest caveat — the config is a bearer token.** `wtc1:` is AES-256-GCM
*packed*, but with a **fixed key derived from a constant app label**
(`SHA-256("web-tunnel encrypted client config v1")`), not a per-user secret.
That layer is obfuscation/integrity-at-rest, **not** confidentiality against
anyone who has the code. Treat the blob like a password: anyone who obtains it
holds that client's Bale session and can use the tunnel until the operator
revokes the profile or the server's pinned fingerprint changes. Deliver it
over a channel the adversary can't read, and don't reuse one config across
people.

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

### Wire format (Meet carrier)

The data bytes never travel as chat text any more — they ride the Meet call's
LiveKit media connection (the synthetic `wt-media-packets` track, because the
platform blocks data-channel publishing). On the wire to Bale's SFU each
payload is just AEAD ciphertext carried as media-track frame bytes: no
headers, no recognisable protocol bytes inside, and nothing hidden inside a
real picture. The framing the receiver parses lives *inside* that ciphertext
(magic prefix + handshake/frame/mux), so Bale only ever sees opaque media
packets on an ordinary-looking call.

The only thing that still travels as a tiny **magic-prefixed message** is
call setup: after `Meet/StartCall` the client signals the callee with
`__WT_MEET__<callId>` so the server can `AcceptCall` and join the same room.
The magic prefixes (`__WT_REQ__`, `__WT_OK__`, `__WT_DENY__`, `__WT_FRAME__`,
`__WT2_FRAME__`, `__WT_MEET__`, defined in
[`shared/src/magic.ts`](./web-tunnel/shared/src/magic.ts)) let the dispatcher
tell tunnel traffic apart from anything else and ignore non-tunnel input.

This is honest about what it is: it does **not** try to look like a normal
video call ("steganography"). It looks like two accounts on a Bale Meet call
exchanging opaque media. The hiding power is "Bale won't single this call out
among millions", not "this is indistinguishable from a real face-to-face
call" — a motivated platform-side classifier could still flag the traffic
pattern, which is why the tunnelling accounts are operator-owned throwaways
(see the account model above).

### Local secrets

- **Server password / PSK.** Set by the operator on the server (`WT_PASSWORD`
  / Start screen). Derives the dashboard upload HMAC key and seeds the v2 PSK
  handshake; it is not embedded in the client config and never goes on the
  wire as plaintext.
- **Both Bale session JWTs (operator-side).** The server account lives at
  `~/.webtunnel/server-native-session.json` and the provisioned client account
  at `~/.webtunnel/server-managed-client-session.json`. Both sit on the
  operator's machine — guard the server box accordingly, since it holds the
  keys to every user's tunnel.
- **Client config blob (user-side).** The `wtc1:` string carries the client
  Bale session; the client app stores it locally (Electron `safeStorage` /
  Android `SessionStore`). Bearer credential — see the caveat above.
- **Server identity key (v2).** `~/.webtunnel/server-v2-identity.json` (Ed25519).
  Rotating it invalidates the `serverFingerprint` pinned in every issued
  config, same as an SSH host key — you'd reissue configs.

### Threats this design does *not* defeat

- **Traffic analysis at the ISP.** TLS to Bale's servers is fine, but the
  *pattern* (constant chat with one contact, message sizes, inter-arrival
  times) is visible to anyone watching the link. A determined adversary doing
  on-path classification could spot it.
- **Bale account ban.** Bale can detect the abnormal traffic and disable the
  tunnelling accounts. The design assumes accounts are cheap to replace —
  and, by holding both accounts operator-side, a ban hits the operator's
  throwaways, not the end user's personal account.
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
  — run the portable `NovaNet-Client-0.4.2.exe`, paste the operator-issued
  `wtc1:` config, hit Start, point apps at SOCKS5 `127.0.0.1:1080`. (No Bale
  login on the user's side.)

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
pnpm release:windows    # NovaNet-Server-0.4.2.exe + NovaNet-Client-0.4.2.exe
pnpm release:android    # release APK via Gradle
pnpm release:all        # both of the above
```

The built artifacts (`.exe`, `.apk`, archives) are **not committed to the
repository** — `release/` and binary extensions are git-ignored. The operator
builds them and uploads/distributes the NovaNet client and server to users
out-of-band; nothing in git contains a runnable binary.

## Threat model and limits (v1)

- **Authentication is a per-user config blob.** Each client gets its own
  `wtc1:` config keyed by `clientId`; the server rejects unknown or
  duplicate-in-use ids, and deleting a profile revokes that user. But the
  blob is a **bearer token** (fixed-key AES-GCM, no per-user secret) — anyone
  who gets a copy can use it until it's revoked. Deliver it privately.
- **The server holds every user's Bale credentials.** That's the safety
  trade-off: the end user is never exposed, but the server box is now a
  high-value target. If it's compromised, every provisioned client account
  goes with it. Lock it down.
- **Bale account hygiene.** The operator must register dedicated throwaway
  accounts for *both* roles — abnormal traffic looks abnormal and risks bans.
- **Throughput.** The transport is Meet-only — the old ~5–30 KB/s chat
  carrier was removed in 0.4.2. Because the platform blocks data-channel
  publishing, packets ride the Meet media connection (the synthetic
  `wt-media-packets` track); that is much faster than the old chat carrier
  but still beta, so expect rough edges (reconnects, call-setup races,
  packet retransmits on the media path).
- **Code-signing.** Windows binaries are unsigned, so SmartScreen will warn
  on first run.

## License

Vendored third-party code keeps its original license (e.g.
`HEV-SOCKS5-TUNNEL-LICENSE.txt` in `client-android/`). Project license: TBD.
