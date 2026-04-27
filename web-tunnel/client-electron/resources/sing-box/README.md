# sing-box runtime

This folder is where `sing-box.exe` lives at runtime.

The Windows whole-system tunnel and LAN-share features in `WebTunnel-Client.exe`
spawn `sing-box.exe` from this directory. You have two options:

1. **Auto-fetch** (recommended): the client will offer to download a pinned
   release (~20 MB) from https://github.com/SagerNet/sing-box/releases on first
   use. The download is cached here for reuse.

2. **Manual**: place `sing-box-<version>-windows-amd64/sing-box.exe` directly
   into this folder. Any recent 1.10+ build works; the configs we generate use
   gvisor stack, `auto_route`, and the `socks` outbound — all stable since 1.7.

The `.gitignore` in this directory keeps the binary out of git.
