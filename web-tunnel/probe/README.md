# Bale Probe Notes (captured 2026-04-21)

Captured via Playwright MCP on `web.bale.ai` with a logged-in test account.
Source: main entrypoint `static/js/index.52867891.js` and async chunks.
Raw dumps: `bale-postlogin-network.txt`, `bale-widecap.txt`.

## Transport

Two modes, app selects dynamically:

- **gRPC-Web** over HTTP/2 to `https://next-ws.bale.ai/{Service}/{Method}`, `content-type: application/grpc-web+proto`, client lib `@improbable-eng/grpc-web`. Used pre-login and for `bale.auth.v1.Auth` always.
- **WebSocket RPC** at `wss://next-ws.bale.ai/ws/?uid={userId}`. Desktop clients switch to WS after login; iOS is forced to WS. Carries the same protobuf messages framed into WS frames.

Auth headers present on every gRPC-Web call:

```
session_id: <millis-like id>
mt_session_id: <same>
app_version: 151668
mt_app_version: 151668
browser_type: 1
mt_browser_type: 1
os_type: 4
mt_os_type: 4
browser_version: 143.0.0.0
mt_browser_version: 143.0.0.0
x-grpc-web: 1
content-type: application/grpc-web+proto
```

Once logged in, the server issues a bearer token used by subsequent calls. Tokens live in `localStorage` (see `local-storage-keys.txt` in this folder), not IndexedDB.

## RPC inventory (core for this project)

Send / receive messages:
- `bale.messaging.v2.Messaging/SendMessage`
- `bale.messaging.v2.Messaging/SendMultiMediaMessage`
- `bale.messaging.v2.Messaging/LoadDialogs` (chat list)
- `bale.messaging.v2.Messaging/LoadHistory`
- `bale.message_stream.v1.MessageStream/ReceiveMessageStream` (server-stream)
- `bale.maviz.v1.MavizStream/SubscribeToUpdates` (server-stream deltas)
- `bale.maviz.v1.MavizStream/GetDifference` (delta sync cursor)

Voice/video calls (the LiveKit-tunnel path):
- `bale.meet.v1.Meet/StartCall`
- `bale.meet.v1.Meet/AcceptCall`
- `bale.meet.v1.Meet/GetWssURL` — **returns the LiveKit signaling URL + access token for a call**
- `bale.meet.v1.Meet/DiscardCall`
- `bale.meet.v1.Meet/GetCallState`

Auth (already working via gRPC-Web):
- `bale.auth.v1.Auth/StartPhoneAuth` → triggers OTP SMS
- `bale.auth.v1.Auth/ValidateCode` → exchanges OTP for session
- `bale.auth.v1.Auth/GetJWTToken` / `GetBaleTicket` — tickets for downstream services
- `bale.auth.v1.Auth/SignOut` / `TerminateSession`

## Client-side data model (from IndexedDB `db`)

Dialogs store shape:
```
{ peer: {type, id}, unreadCount, sortDate, senderUid, rid, date,
  message: { textMessage: { text, mentions[] } | documentMessage: {...} },
  state, firstUnreadDate, exInfo, isMessageForwarded,
  unreadMentions[], unreadReactions[], markedAsUnread, isMute, id }
```

Field-name gotchas (not the conventional names):
- `rid` — per-message random id (18–19 digit string), not `messageId`.
- `senderUid` — not `senderId`.
- `date` is epoch milliseconds.

Key stores in `db`: `_schema`, `dialogs`, `short_dialogs`, `pinned_dialogs`, `pending_messages`, `pending_operations`, `sequences` (**delta-sync cursor store**), `users`, `full_users`, `groups`, `full_groups`, `contacts`, `sticker_collections`, `saved_gifs`, `top_peers`.

## Implications for Web Tunnel

- **`aiobale` (Python) is the right sidecar** for the server's user-account session. It already models the gRPC-Web + WS-RPC protocol. Reverse-engineering the binary protobuf framing ourselves is a last resort — we'd rather pin to `aiobale` and vendor a patch if they haven't added `bale.meet.v1.Meet/GetWssURL` yet.
- **LiveKit carrier is feasible.** Our client calls `Meet/StartCall` on the server's user account (via the Bale session), both endpoints call `Meet/GetWssURL` to learn the signaling URL + access token, both join, both use the data channel. No separate LiveKit infra needed — we're riding Bale's.
- **Chat carrier** is `SendMessage` for outbound + `ReceiveMessageStream` for inbound. Use the `__WT_FRAME__<base64>` envelope we already defined in `shared/magic.ts`.
- **Rate-limit budget:** Bale rate-limits non-auth gRPC aggressively. Plan for ~1–3 messages/sec sustained on the chat path.

## Do NOT probe further without asking

Further steps against a real Bale account require explicit permission:
- Sending a message
- Initiating a call
- `TerminateSession` / any session-management action
- Reading other users' chats (privacy-sensitive)
