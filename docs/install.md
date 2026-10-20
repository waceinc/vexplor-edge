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
| Firewall towards the equipment | The PC → PLC ports (OPC UA 4840, Modbus 502, MQTT 1883/8883; from 1.2.0 S7 102 and the MC port set in the PLC; from 1.3.0 XGT 2004) | Nothing new |
| Firewall towards the outside | The PC → the server on 443 (or the proxy) | The PC → the proxy (or the server on 443) |
| Inbound to the PC | **None** | **None** |

Choose A when the equipment network has no route out at all; choose B when one PC on the equipment network may go out
through the site proxy. In both, nothing connects in.

## 2. What it connects to (the complete list)

| Destination | Why | When |
|---|---|---|
| The server address in the configuration, port 443 (or through `proxy`) | Read list, batches, registration | Always |
| The PLC endpoints in the approved read list (OPC UA, Modbus TCP, MQTT; from 1.2.0 S7 and MC; from 1.3.0 XGT) | Reading values | After approval |
| `update.manifestUrl` | Release notice, once a day | Only if configured |

There is nothing else. The tests check this (STD-009 T9) by recording every connection attempt.

## 3. Install — one click

Supported: **Linux x64 · arm64** (systemd) and, from 1.2.0, **Windows x64** (a Windows service — [Windows](#windows)
below). The factory PC connects to the server over **https** (plain http only to the same PC, for
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

### Windows

From 1.2.0. Windows 10 or Server 2016 or later, x64, with Windows PowerShell 5.1 (part of Windows). On the server's
screen choose the **Windows** tab; it makes the same command with the server and the code filled in. Open a Command
Prompt or PowerShell with **Run as administrator** and paste it:

```bat
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://github.com/waceinc/vexplor-edge/releases/latest/download/get.ps1))) -Server https://aas.example.com -Code 7KQ4-M2XD-9PRT"
```

`get.ps1` takes `vexplor-edge-<version>-win-x64.zip` from the same release, checks it against `SHA256SUMS`, and only
then runs the `install.ps1` inside. Options after the code are passed on — `-Proxy http://proxy:3128`,
`-CaFile corp-ca.pem`, `-CredentialsFile credentials.json`, `-Name "Line 1"` (default: the PC's name), `-NoService`.

- **Execution policy** is not changed. The command runs `get.ps1` as text (execution policy covers script files), and
  only the installer process it starts gets `-ExecutionPolicy Bypass`, for that one file.
- **TLS 1.2** is switched on for that window — Windows PowerShell 5.1 on Windows 10 / Server 2016 offers TLS 1.0 by
  default and GitHub refuses it (`3072` in the command is TLS 1.2).
- **Proxy**: `-Proxy` is used for the downloads and written to `edge.json`. Without it the downloads use the proxy set
  in Windows (Internet Options). If the first download (`irm …/get.ps1`) needs a proxy Windows does not know, add
  `-Proxy http://proxy:3128 -ProxyUseDefaultCredentials` to `irm` as well — the server's screen does this when a proxy is
  entered.

What it sets up:

| Where | What | Access |
|---|---|---|
| `C:\Program Files\VEXPLOR Edge\vexplor-edge.exe` | The program (one executable) | Administrators write, everyone reads |
| `C:\Program Files\VEXPLOR Edge\vexplor-edge-service.exe` · `.xml` | The service wrapper, WinSW 2.12.0 (MIT) and its settings | as above |
| `C:\ProgramData\VEXPLOR Edge\edge.json` | Configuration (UTF-8, no byte order mark) | SYSTEM · Administrators write, the service reads |
| `C:\ProgramData\VEXPLOR Edge\state\` | Key (`identity.json`), queue, refused batches, OPC UA certificates | SYSTEM · Administrators · the service only |
| `C:\ProgramData\VEXPLOR Edge\logs\` | `vexplor-edge-service.out.log` (the collector's JSON lines) and the wrapper's log, rolled at 10 MB, 8 kept | as above |
| Service `vexplor-edge` ("VEXPLOR Edge") | Account `NT AUTHORITY\LocalService`, automatic (delayed) start, restarted 10 s after a failure (60 s from the third), stopped with Ctrl+C | — |

**Why a wrapper.** Node.js cannot answer the Windows service manager: a plain executable registered with `sc.exe` is
ended after 30 seconds (error 1053). A small native wrapper is needed; WinSW is MIT, a single file, and its download is
pinned by SHA-256 in `scripts/pack.mjs`. Its license text is in the package (`licenses/WinSW-LICENSE.txt`). The account,
the start type and the restart rules are set by `install.ps1` through the service manager itself (CIM and `sc.exe`).

**Running it.** `Get-Service vexplor-edge` · `Restart-Service vexplor-edge` (after a configuration change) ·
`Get-Content -Wait "C:\ProgramData\VEXPLOR Edge\logs\vexplor-edge-service.out.log"` ·
`& "C:\Program Files\VEXPLOR Edge\vexplor-edge.exe" --version`.

**By hand (a PC without internet).** Take `vexplor-edge-<version>-win-x64.zip` and `SHA256SUMS` from Releases on another
PC, then in an elevated PowerShell:

```powershell
(Get-FileHash .\vexplor-edge-<version>-win-x64.zip -Algorithm SHA256).Hash   # compare with the line in SHA256SUMS
Expand-Archive .\vexplor-edge-<version>-win-x64.zip -DestinationPath . ; cd .\vexplor-edge-<version>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Server https://aas.example.com -Code 7KQ4-M2XD-9PRT
```

**Upgrade.** The same one line with `-Upgrade` in place of `-Server … -Code …` (or `install.ps1 -Upgrade` from a
newer package): it stops the service, replaces the program and starts it again. Registration, approval and `edge.json`
stay.

## 4. Passwords and certificates

- **PLC passwords** live in a credentials file on this PC, by endpoint — `{ "opc.tcp://10.0.0.5:4840": { "userName",
  "password" } }` — passed with `--credentials-file`. They are never in the AAS or the read list. An MQTT broker login
  goes in the same file under the broker's address (1.1.0 and later).
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
(and `/var/lib/vexplor-edge` once its queue is no longer needed).

Windows: the one line with `-Uninstall` in place of `-Server … -Code …`, or in an elevated PowerShell
`powershell -ExecutionPolicy Bypass -File "C:\Program Files\VEXPLOR Edge\install.ps1" -Uninstall`. It removes the
service and the program and keeps `C:\ProgramData\VEXPLOR Edge`; `-Purge` deletes that too (key and queue).

Revoke the device on the server as well.

## 7. What was checked

- **One click (2026-10-18, 1.0.0)** — the exact command the server screen makes was run in clean Ubuntu 24.04
  containers (arm64 and x86_64): release download → `SHA256SUMS` check → install → pre-approved registration → reading
  an OPC UA virtual PLC → values stored on the server (21 values on arm64, 70 on x86_64, machine connection OK). The
  containers have no systemd, so it ran with `--no-service`.
- **Service (earlier version — the same installer, AAS Studio 2.4 time)** — installed on a clean Ubuntu 24.04 (x86_64)
  machine as a systemd service, registered, approved and sent values from an OPC UA server over the network.
- **Windows (1.2.0)** — checked on every change by CI on a Windows Server runner (`windows-latest`, job `windows`):
  the unit tests on a Windows file system, the package built there, the scripts parsed by Windows PowerShell 5.1, the
  executable's `--version`, and the package installed as a real service against a stand-in server — runs as
  LocalService, writes and sends its queue, starts again after the program is killed, stops with the service, upgrades
  and uninstalls (`test/windows/service-smoke.ps1`). First green run: 2026-10-19 on the Windows commit (697cacf) — 52 of 52
  unit tests, the package built, and every service check `[OK]` (registered once, running as LocalService, delayed
  automatic start, restart on failure, no byte order mark, key and queue closed to Users, a batch sent, log written,
  started again after a kill, stopped with no program left, upgrade kept the registration, removed with `-Purge`).
  Not yet installed on a factory PC.
