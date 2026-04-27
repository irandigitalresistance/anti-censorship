# Web Tunnel client patch — "not connected" fix

One file to edit. Two lines to change. Restart the app. Done.

## File to edit

```
<where-you-extracted>\win-unpacked\resources\bale-sidecar\bale_sidecar\run.py
```

Open it in Notepad (right-click → *Edit* / *Open with Notepad*).

## Change 1 — delete one line near the top

Find and **delete** this line:

```python
from __future__ import annotations
```

## Change 2 — change one line a bit further down

Find this line (~line 100ish, inside `_amain`):

```python
            await client.start()
```

Replace it with:

```python
            await client.start(run_in_background=True, signal_handling=False)
```

## Save and restart

Save the file, close and re-open `Web Tunnel.exe`. Within a few seconds the
header should switch from "not connected" to "logged in as <your name>", and
the chat picker dropdown should fill in.

If you still see "not connected" after 30s, screenshot the full window
(including any red error box) and send it back.
