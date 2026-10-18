# Installing the remote collector (VEXPLOR Edge)

*Korean: [설치.md](설치.md)* · User guide: [usage.md](usage.md) · Contract: [contract.md](contract.md)

VEXPLOR Edge is one program on one PC in the factory. It reads PLCs and controllers named by a **read list a person
approved on the server**, and sends signed batches out over HTTPS. It is read only, opens no port, and has no remote
stop. The same program works with any server that follows the contract `vexplor.edge/1` (VEXPLOR AAS
Studio, VEXPLOR Logic Studio Cloud).

## 1. Where to put it — two layouts

| | A. DMZ / office network | B. Equipment network |
|---|---|---|
| The PC sits | Between the office and equipment networks, reaching both | On the equipment network, with an outbound route to the server (often through a proxy) |
| Firewall towards the equipment | The PC → PLC ports (OPC UA 4840, Modbus 502, MQTT 1883/8883) | Nothing new |
| Firewall towards the outside | The PC → the server on 443 (or the proxy) | The PC → the proxy (or the server on 443) |
| Inbound to the PC | **None** | **None** |

Choose A when the equipment network has no route out at all; choose B when one PC on the equipment network may go out
through the site proxy. In both, nothing connects in.

## 2. What it connects to (the complete list)

| Destination | Why | When |
|---|---|---|
| The server address in the configuration, port 443 (or through `proxy`) | Read list, batches, registration | Always |
| The PLC endpoints in the approved read list (OPC UA, Modbus TCP, MQTT) | Reading values | After approval |
| `update.manifestUrl` | Release notice, once a day | Only if configured |

There is nothing else. The tests check this (STD-009 T9) by recording every connection attempt.

## 3. Install — one click

Supported: **Linux x64 · arm64** (systemd). **Windows is in preparation** — until then use a Linux PC or a Linux VM on
the site's Windows server. The factory PC connects to the server over **https** (plain http only to the same PC, for
tests).

**On the server's screen (VEXPLOR AAS Studio 2.7.0 or later)** — Settings → Remote collectors → **"+ Connect a
collector"**. Check the server address and the list it will read, press "Make the connect command", and you get one
line. With "Approve this list so it reads at once" ticked, the approval is done too. If it is off, an admin presses
"Turn on remote collection" on the same screen.

**On the factory PC** — paste that line into a terminal.

```bash
curl -fsSL https://github.com/waceinc/vexplor-edge/releases/latest/download/get.sh | sudo sh -s -- --server https://aas.example.com --code 7KQ4-M2XD-9PRT
```

`get.sh` takes the package for the PC's CPU (x64 · arm64) from the same release, checks it against `SHA256SUMS`, and
only then runs the `install.sh` inside. Options after the code are passed on — `--proxy http://proxy:3128`,
`--ca-file corp-ca.pem`, `--credentials-file credentials.json` (section 4), `--name "Line 1"` (default: the PC's name).

Done when the screen shows the PC's name and **"Receiving"**. If the list was not approved upfront, press "Review and
approve" under "Connected collectors" — a collector waiting for approval asks every 10 seconds, so it starts reading
right after. It reads nothing before approval.

### By hand (a PC without internet)

Download `vexplor-edge-<version>-linux-x64.tar.gz` (or `linux-arm64`) and `SHA256SUMS` from
[Releases](https://github.com/waceinc/vexplor-edge/releases) on another PC, bring them over, then:

```bash
sha256sum -c SHA256SUMS --ignore-missing
tar xzf vexplor-edge-<version>-linux-x64.tar.gz && cd vexplor-edge-<version>
sudo ./install.sh --server https://aas.example.com --code 7KQ4-M2XD-9PRT [--proxy http://proxy:3128] [--ca-file corp-ca.pem]
```

The code is the `--code` value of the command "Make the connect command" shows (valid 24 h, one use).

Program in `/opt/vexplor-edge`, configuration in `/etc/vexplor-edge/edge.json`, key and queue in
`/var/lib/vexplor-edge` (service account only). The service `vexplor-edge` runs hardened (no new privileges, read-only
system, its state folder writable, no capabilities). Logs: `journalctl -u vexplor-edge`. Version:
`/opt/vexplor-edge/vexplor-edge --version`.

## 4. Passwords and certificates

- **PLC passwords** live in a credentials file on this PC, by endpoint — `{ "opc.tcp://10.0.0.5:4840": { "userName",
  "password" } }` — passed with `--credentials-file`. They are never in the AAS or the read list.
- **OPC UA certificates**: the collector makes its own certificate in `<state>/opcua-pki`. A server certificate it has
  never seen is refused and kept in `<state>/opcua-pki/rejected`; move it to `trusted/certs` to trust it, or set
  `"opcua": { "trustFirstUse": true }`. The OPC UA server must trust the collector's certificate too.

## 5. Running it

- An outage loses nothing: batches wait in `<state>/queue` and go out in order when the server answers again (each is
  stored once). Past `maxQueuedBatches` (default 100 000), or older than `maxQueueDays` (default 30), the oldest are
  dropped and reported, never silently.
- **Send changes only (OPC UA)**: with `"opcua": { "mode": "subscribe" }` the PLC samples each tag on its interval and
  the edge sends a value only when it changes; `"deadband": <number>` also skips smaller changes of analog (float) tags —
  never counters, states or text. An unchanged value is sent again every `"resendMs"` (default 300 000, 5 minutes) so it
  still shows as received. Measured on a PLC simulator, 6 tags every second for 5 minutes: polling 1 794 values
  (283 KB), subscribe 729 (130 KB, −54 %), subscribe with deadband 1.0 436 (88 KB, −69 %). The default stays `"poll"`.
- A batch the server refuses as malformed goes to `<state>/refused` for a person to look at.
- A revoked device stops sending by itself and keeps its queue; it never registers again on its own.
- Update notices (optional): with `"update": { "manifestUrl": "https://…", "publicKey": "<release key>" }` it reports a
  newer signed release in the log and the next batch's status. It downloads and installs nothing — install the new
  package with the same installer.

## 6. Remove

Linux: `sudo systemctl disable --now vexplor-edge && sudo rm -r /opt/vexplor-edge /etc/vexplor-edge /etc/systemd/system/vexplor-edge.service`
(and `/var/lib/vexplor-edge` once its queue is no longer needed). Revoke the device on the server as well.

## 7. What was checked

- **One click (2026-10-18, 1.0.0)** — the exact command the server screen makes was run in clean Ubuntu 24.04
  containers (arm64 and x86_64): release download → `SHA256SUMS` check → install → pre-approved registration → reading
  an OPC UA virtual PLC → values stored on the server (21 values on arm64, 70 on x86_64, machine connection OK). The
  containers have no systemd, so it ran with `--no-service`.
- **Service (earlier version — the same installer, AAS Studio 2.4 time)** — installed on a clean Ubuntu 24.04 (x86_64)
  machine as a systemd service, registered, approved and sent values from an OPC UA server over the network.
- Windows is in preparation.
