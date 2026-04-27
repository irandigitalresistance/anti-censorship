import asyncio
import json
import logging
import sys
import traceback
from typing import Any

from aiobale import Client, Dispatcher
from aiobale.enums import ChatType
from aiobale.types import Message

# Surface aiobale's internal update-parse errors so we can see what's getting
# dropped (set via Session constructor later).
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s: %(message)s")


def _emit(obj: dict[str, Any]) -> None:
    """Write one JSON object as a single line to stdout, flushed."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _emit_error(err: str, **extra: Any) -> None:
    _emit({"op": "error", "error": err, **extra})


def _chat_type_from_str(s: str) -> ChatType:
    try:
        return getattr(ChatType, s.upper())
    except AttributeError as e:
        raise ValueError(f"unknown chat_type: {s!r}") from e


def _chat_type_to_str(ct) -> str | None:
    if ct is None:
        return None
    # aiobale sometimes hands us the raw int (1, 2, ...) instead of a
    # ChatType enum instance, so normalise both paths to the name.
    if isinstance(ct, int):
        try:
            return ChatType(ct).name
        except ValueError:
            return str(ct)
    try:
        return ct.name
    except AttributeError:
        return str(ct)


async def _read_stdin_lines() -> asyncio.Queue:
    """Consume stdin line-by-line into an asyncio.Queue on a thread."""
    q: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def reader() -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            asyncio.run_coroutine_threadsafe(q.put(line), loop)
        asyncio.run_coroutine_threadsafe(q.put(None), loop)

    import threading

    threading.Thread(target=reader, daemon=True).start()
    return q


async def _handle_command(client: Client, me_id: int, cmd: dict[str, Any]) -> None:
    op = cmd.get("op")
    req_id = cmd.get("req_id")
    try:
        if op == "send_message":
            text = cmd["text"]
            chat_id = int(cmd["chat_id"])
            chat_type = _chat_type_from_str(cmd["chat_type"])
            sent: Message = await client.send_message(text=text, chat_id=chat_id, chat_type=chat_type)
            _emit({
                "op": "response",
                "req_id": req_id,
                "ok": True,
                "data": {"message_id": getattr(sent, "message_id", None), "date": getattr(sent, "date", None)},
            })
            return
        if op == "load_dialogs":
            limit = int(cmd.get("limit", 40))
            dialogs = await client.load_dialogs(limit=limit)
            out = []
            for d in dialogs:
                chat = getattr(d, "chat", None) or getattr(d, "peer", None)
                out.append({
                    "chat_id": getattr(chat, "id", None),
                    "chat_type": _chat_type_to_str(getattr(chat, "type", None)) if chat is not None else None,
                    "title": getattr(d, "title", None) or getattr(getattr(d, "user", None), "name", None),
                    "last_message": getattr(getattr(d, "last_message", None), "text", None),
                    "unread": getattr(d, "unread_count", None),
                })
            _emit({"op": "response", "req_id": req_id, "ok": True, "data": {"dialogs": out}})
            return
        if op == "ping":
            _emit({"op": "response", "req_id": req_id, "ok": True, "data": {"me_id": me_id}})
            return
        if op == "shutdown":
            _emit({"op": "response", "req_id": req_id, "ok": True, "data": {"bye": True}})
            raise SystemExit(0)
        _emit({"op": "response", "req_id": req_id, "ok": False, "error": f"unknown op {op!r}"})
    except SystemExit:
        raise
    except Exception as e:
        _emit({"op": "response", "req_id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"})


def run_sidecar(*, session_path: str) -> int:
    async def _amain() -> int:
        dp = Dispatcher()
        client = Client(dp, session_file=session_path)
        me_id_holder: dict[str, int] = {}

        @dp.message()
        async def on_msg(msg: Message) -> None:  # type: ignore[no-redef]
            try:
                sender_id = getattr(msg, "sender_id", None)
                sys.stderr.write(f"[sidecar] @dp.message fired: sender={sender_id} text={getattr(msg, 'text', None)!r}\n")
                sys.stderr.flush()
                if sender_id is not None and sender_id == me_id_holder.get("id"):
                    # Don't echo our own outbound messages back to the Node side.
                    return
                chat = getattr(msg, "chat", None)
                _emit({
                    "op": "event",
                    "kind": "message",
                    "chat": {
                        "id": getattr(chat, "id", None),
                        "type": _chat_type_to_str(getattr(chat, "type", None)) if chat is not None else None,
                    },
                    "sender_id": sender_id,
                    "text": getattr(msg, "text", None),
                    "message_id": getattr(msg, "message_id", None),
                    "date": getattr(msg, "date", None),
                })
            except Exception:
                _emit_error(f"on_msg failed: {traceback.format_exc()}")

        # Wrap handle_update so we can see *every* update that arrives, not just
        # the ones that successfully match a handler.
        orig_handle_update = client.handle_update

        async def _traced_handle_update(body: Any) -> Any:
            body_type = type(body).__name__
            sys.stderr.write(f"[sidecar] handle_update: body_type={body_type}\n")
            sys.stderr.flush()
            try:
                return await orig_handle_update(body)
            except Exception:
                sys.stderr.write(f"[sidecar] handle_update raised:\n{traceback.format_exc()}")
                sys.stderr.flush()
                raise

        client.handle_update = _traced_handle_update

        try:
            # run_in_background=True makes start() return after connecting.
            # The default (False) blocks in the listen loop forever, which would
            # prevent us from emitting the `ready` event and reading stdin.
            await client.start(run_in_background=True, signal_handling=False)
            # Flip aiobale's session debug flag so update-parse errors are logged.
            try:
                client.session.show_update_errors = True
            except Exception:
                pass
        except Exception as e:
            _emit_error(f"start failed: {type(e).__name__}: {e}")
            return 1

        me = getattr(client, "me", None)
        me_id = getattr(me, "id", None)
        if me_id is None:
            _emit_error("could not determine logged-in user id after start()")
            await client.stop()
            return 1
        me_id_holder["id"] = me_id
        _emit({
            "op": "ready",
            "me": {
                "id": me_id,
                "name": getattr(me, "name", None),
                "phone": getattr(me, "phone_number", None),
            },
        })

        queue = await _read_stdin_lines()
        try:
            while True:
                line = await queue.get()
                if line is None:
                    break
                try:
                    cmd = json.loads(line)
                except json.JSONDecodeError as e:
                    _emit_error(f"bad json: {e}")
                    continue
                try:
                    await _handle_command(client, me_id, cmd)
                except SystemExit:
                    break
        finally:
            try:
                await client.stop()
            except Exception:
                pass
        return 0

    try:
        return asyncio.run(_amain())
    except KeyboardInterrupt:
        return 0
