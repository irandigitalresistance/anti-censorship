# Iran-side operator runner

This directory contains the standalone runtime that runs a trained
RL-DPI policy against a real Iranian connection. **No simulator,
no Docker, no GPU required** — just Python 3.10+ and PyTorch CPU.

## What you need before you start

1. A trained policy checkpoint (`policy.pt`) — produced by training in
   the lab against the simulator. We include three:
   - `policies/ppo_mixed.pt` — generalises across mci/irancell/shatel
     (best for unknown ISPs).
   - `policies/geneva_v2.pt` — best raw bypass rate, but locked to the
     mutation chain Geneva evolved.
   - `policies/ppo_distill_v2.pt` — middle ground; uTLS-aware.
2. Python ≥ 3.10 with `torch`, `numpy`, `dpkt`. CPU torch is fine
   (the policies are small, < 5 MB each):
   ```
   pip install torch==2.2.2 numpy dpkt
   ```

## One-shot probe — does the policy bypass DPI on this ISP?

```
python run_agent.py --policy policies/ppo_mixed.pt \
    --target www.twitter.com:443
```

Output (success):
```
[runner] loaded policy policies/ppo_mixed.pt (kind=ppo)
  www.twitter.com:443                   plan=chain:utls_chrome+split_byte1
  verdict=server_hello  (87ms)
```

If `verdict=server_hello` or `tls_alert`, the policy successfully
crafted a ClientHello that traversed the DPI without an injected RST.
`verdict=rst` means this ISP's DPI generation isn't covered by the
policy — try a different policy or retrain.

## Daily-use SOCKS5 proxy

Point your browser at `127.0.0.1:1080` as a SOCKS5 proxy, then:

```
python run_agent.py --policy policies/ppo_mixed.pt \
    --socks5 127.0.0.1:1080
```

For every TCP CONNECT request the proxy receives, the policy picks a
mutation, applies it to the outbound TLS handshake, and bridges
bytes. The mutation choice is *per connection* — the agent acts
state-conditionally, so you may see different mutations chosen for
different SNIs.

## Probe a list — measurement campaign

```
cat > /tmp/snis.txt <<EOF
www.twitter.com
web.telegram.org
www.facebook.com
www.instagram.com
www.youtube.com
EOF
python run_agent.py --policy policies/ppo_mixed.pt \
    --probe-sni-list /tmp/snis.txt --json > probe.json
```

Output is one JSON record per SNI with the chosen plan, verdict, and
elapsed-ms. Useful for filing OONI-style measurement reports without
running ooniprobe.

## What the policy actually does

Every connection goes through three steps:

1. **Build observation** — fixed-length feature vector with the SNI
   tokens, an ISP one-hot (set to "unknown" because we don't know
   which Iranian ISP you're on at runtime), and zero-history.
2. **Pick action** — argmax over the policy's action distribution.
   For PPO this is a stochastic sample by default; we force greedy
   (ε=0) for deployment. The action ID maps to one of ~58 mutation
   plans in `rlagent/envs/mutations.py`.
3. **Transmit** — open a TCP connection to (target_ip, target_port),
   apply the plan's chunks (with optional inter-chunk delays), and
   read the verdict from the first reply byte (`0x16` →
   ServerHello, `0x15` → Alert, `RST` → DPI killed it).

The policy ships frozen — no online learning at the operator's end.
If the DPI changes and the policy stops working, you need a new
policy (retrained against an updated simulator with the new DPI
profile).

## Operational caveats

- **Active probing**: Iran's DPI sends fake-SNI ClientHellos to
  servers that just passed an SNI check. The simulator models this;
  the policy learned to not pick chains that trip the probe. But on
  unknown ISPs there may be additional active-probing layers we
  didn't model. Watch the verdict pattern — sudden drop to `rst`
  after some success suggests graylisting.
- **Graylist self-defence**: the policy learned to maintain a low
  per-IP traffic rate. Don't stack multiple instances of this proxy
  behind the same source IP unless you've trained a coordinated
  policy.
- **Threat to the operator**: this is an unauthorised circumvention
  tool under Iran's Computer Crimes Law. The cryptographic primitives
  emitted by the policy are visible on the wire; ISP traffic logs
  will show you connecting to known-blocked SNIs. Use a clean SIM /
  burner connection where appropriate. **No, this is not anonymous;
  it is an evasion of the SNI/JA3 layer only.**
- **No telemetry**: the runner sends nothing back to us. Logs are
  stdout-only.

## Limitations vs. the published Iran-side measurements

- We tested against the simulator, not real Iran.
- Only the four ISP profiles (mci, irancell, shatel, mci_patched, mci_v2)
  are modelled; real Iran has per-ISP-per-day variation.
- No defence against full BGP blackouts (§4.1 of report.md).
- No defence against the SIAM subscriber-control plane (§4.6).

## Safer fallbacks if this stops working

If a policy goes stale and starts failing, the documented fallback
order is (cheapest first):
1. `dpi_fuzzer.py` (in `D:\censorship-details\`) → see which raw
   mutations still bypass on your specific ISP today.
2. `byedpi`, `zapret`, `GoodbyeDPI` — established userland-portable
   tools maintained for years, broader catalogue than ours.
3. Reality / AmneziaWG / Hysteria2 — full obfuscated tunnels, much
   higher throughput than per-handshake-mutation tricks.

This artifact is research, not infrastructure. The fallbacks above
are infrastructure.
