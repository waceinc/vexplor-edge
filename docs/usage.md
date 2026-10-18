# VEXPLOR Edge — user guide

*한국어: [사용법.md](사용법.md)* · Install summary: [install.md](install.md) · Contract: [contract.md](contract.md)

VEXPLOR Edge is the remote collector you put on one factory PC. It reads only the machines on a list a person approved on
the server, and sends their values out over HTTPS. This guide goes from the first connection through running, trouble
shooting and removal, with the screens and commands in order. Screens are VEXPLOR AAS Studio 2.7.0, the collector is
VEXPLOR Edge 1.0.1, and every capture was taken with a real server, real collectors (1.0.0) and a simulated PLC (2026-10-18).

## Contents

1. [What VEXPLOR Edge is](#1-what-vexplor-edge-is)
2. [What you need](#2-what-you-need)
3. [Equipment links and collection — what is set where, and how values are read](#3-equipment-links-and-collection--what-is-set-where-and-how-values-are-read)
4. [On the server — turn on remote collection](#4-on-the-server--turn-on-remote-collection)
5. [One-click connect](#5-one-click-connect)
6. [Approval — deciding what a collector reads](#6-approval--deciding-what-a-collector-reads)
7. [Seeing the values](#7-seeing-the-values)
8. [Reading a collector's state](#8-reading-a-collectors-state)
9. [Pause · resume · revoke](#9-pause--resume--revoke)
10. [On the factory PC — service, log, files](#10-on-the-factory-pc--service-log-files)
11. [The configuration file `edge.json`](#11-the-configuration-file-edgejson)
12. [Proxy · private CA · PLC passwords · OPC UA certificates](#12-proxy--private-ca--plc-passwords--opc-ua-certificates)
13. [Sending changes only (OPC UA subscriptions · deadband)](#13-sending-changes-only-opc-ua-subscriptions--deadband)
14. [When the line drops — the queue](#14-when-the-line-drops--the-queue)
15. [Upgrading · update notices](#15-upgrading--update-notices)
16. [Installing on a PC without internet](#16-installing-on-a-pc-without-internet)
17. [Removing](#17-removing)
18. [Troubleshooting](#18-troubleshooting)
19. [Security — what it does and does not do](#19-security--what-it-does-and-does-not-do)
- [Appendix. Terms](#appendix-terms)

---

## 1. What VEXPLOR Edge is

When the AAS Studio server is on the same network as the machines, the collector inside the server reads the PLCs
itself. When the server is outside the factory (cloud, head office), it cannot reach them. Put VEXPLOR Edge on one factory
PC and that PC reads the PLCs and sends the values to the server.

### 1-1. One thing first — only what can reach the machines can read them

Machines such as PLCs are usually connected only to the factory network (the range in which factory computers can reach one
another). They cannot be reached from outside. So **the program that reads machine values has to be on the same network as
the machines.**

Where you put the AAS Studio server gives three cases.

| Case | Server location | Who reads the machine values | VEXPLOR Edge |
|---|---|---|---|
| A | Inside the factory | The server, directly | Not needed |
| B | Outside the factory (cloud · head office) | VEXPLOR Edge on a factory PC | **Needed** |
| C | Outside, connected to the factory network by VPN | The server, directly through the VPN | Not required |

### 1-2. The three cases in pictures

**Case A — the server is inside the factory**

```mermaid
flowchart LR
  subgraph F["Factory network"]
    PLC["Machine (PLC)"] -- "values" --> SRV["AAS Studio server"]
    PC["Staff PC<br/>(browser)"] -- "uses the screens" --> SRV
  end
```

The server and the machines are on the same network, so the server reads the values itself. Every function on the screen
works. VEXPLOR Edge is not used.

**Case B — the server is outside the factory (with VEXPLOR Edge)**

```mermaid
flowchart LR
  subgraph F["Factory network"]
    PLC["Machine (PLC)"] -- "reads values" --> EDGE["Factory PC<br/>VEXPLOR Edge"]
  end
  subgraph C["Outside the factory (cloud · head office)"]
    SRV["AAS Studio server"]
  end
  EDGE -- "sends outward only<br/>(internet HTTPS)" --> SRV
```

The server cannot reach the machines inside the factory (there is no way in from outside). Put VEXPLOR Edge on one factory PC
instead: that PC reads the machine values and sends them to the server. The factory only needs **a way out**; no way in from
outside is opened.

In this case **the functions in which the server connects to a machine itself do not work.**

- "Load from equipment" (the button that lists a machine's tags so you can pick them) does not work. Type the tag addresses by hand,
  or add several at once with a pattern. Look the addresses up in the PLC maker's tag list.
- The "Collect" (read once now) button shows a connection failure. You do not need it: the values VEXPLOR Edge sends arrive by
  themselves.

If typing tags by hand is hard, run AAS Studio briefly on a laptop inside the factory **only while setting up**: create the
collection link there with "Load from equipment", save the equipment file with "Download AASX", and upload it to the outside server
with "Open AASX file".

**Case C — the server is outside, but connected to the factory network by VPN**

```mermaid
flowchart LR
  subgraph F["Factory network"]
    PLC["Machine (PLC)"] --- VF["VPN device"]
  end
  subgraph C["Outside the factory (cloud · head office)"]
    VC["VPN device"] --- SRV["AAS Studio server"]
  end
  VF <== "VPN tunnel" ==> VC
```

A VPN is a private tunnel between the factory network and the server's network. With it, the server can reach the machines
inside the factory, so it reads them itself as in case A, and "Load from equipment" works too. VEXPLOR Edge is not required.

Keep in mind:

- **The VPN has to connect the server's network with the factory network** (a site-to-site VPN). A VPN that connects only one
  staff laptop to the factory does not let the server reach the machines.
- It opens a way from outside into the factory, so it often needs **approval from the company's security staff**, and the VPN
  devices need looking after.
- While the VPN is down the server cannot read, and values from that time are not kept. In case B, VEXPLOR Edge keeps values
  on the factory PC while the link is down and sends them when it is back (§14).

### 1-3. What works in each case

| Task | A server inside | B server outside + VEXPLOR Edge | C server outside + VPN |
|---|---|---|---|
| Collecting machine values | Yes | Yes | Yes |
| Picking tags with "Load from equipment" | Yes | **No** — type them, or upload a file made inside the factory | Yes |
| Reading once now with "Collect" | Yes | **No** — values arrive by themselves | Yes |
| Values while the internet · VPN is down | Not applicable | Kept on the factory PC and sent later | Not kept |
| Opening a way into the factory | Not needed | Not needed | **Needed** (VPN) |
| What goes in the factory | The server | One Linux PC | VPN device |

### 1-4. Which case to choose

- If the server can live inside the factory, **case A** is the simplest.
- If the server is in the cloud or at head office and opening a way into the factory network is hard, choose **case B
  (VEXPLOR Edge)**. The rest of this document describes case B.
- If the factory and head office are already connected by VPN, **case C** also works: the server reads directly, without
  VEXPLOR Edge.

What the collector reads is not decided on the factory PC (§3). The collection links (AID) in the server's equipment
files (AASX) become the "read list", and the collector starts reading only after a person approves that list on the server.

## 2. What you need

**Server**

| Item | Details |
|---|---|
| VEXPLOR AAS Studio | 2.7.0 or later (one-click screen). Servers 2.3.0 – 2.6.x also take contract `vexplor.edge/1`, but are connected through the API and a manual install |
| Address | An **https** address the factory PC can reach. The collector does not talk to a server that is not https (except one on the same PC, for tests). Putting HTTPS in front of the server: AAS Studio usage guide §12-3 |
| Read list | At least one collection link (AID) in an equipment file. Without one, the collector connects but has nothing to read (§4-2) |
| Accounts | An admin turns remote collection on; an account with edit rights makes commands and approves |

**Factory PC**

| Item | Details |
|---|---|
| Operating system | Linux x64 or arm64 with systemd. Windows is in preparation — until then use a Linux PC or a Linux VM on a Windows server |
| Tools | `curl`, `sha256sum` (or `shasum`), admin rights (`sudo`). No Node.js — the program is one executable |
| Download | about 44 MB per package (1.0.0) |
| Outbound | to the server address on 443 (directly or through the site proxy) |
| To the machines | to the PLC ports — OPC UA 4840, Modbus TCP 502, MQTT 1883/8883 |
| Inbound | **none.** The collector opens no port |

Where to place the PC: [install.md](install.md) §1 (DMZ / office network, or the machine network).

## 3. Equipment links and collection — what is set where, and how values are read

VEXPLOR Edge connects to equipment from the factory PC, reads, and sends — nothing more. **What to collect — PLC
addresses, register kinds, data types, tag names — is not set on the factory PC. It is set in AAS Studio, in the
collection link (AID) inside the equipment file.** The factory PC's `edge.json` holds only what belongs to that PC
(server address, proxy, certificates, the PLC password file) and the OPC UA collection mode. This section shows what is
set where and how a value travels from the equipment to the server's screen, with real examples.

### 3-1. What is set where

| Setting | Where | How |
|---|---|---|
| Equipment address (endpoint) | AAS Studio — collection link | Field ① of **Create collection link**. Use **the address the factory PC can reach** (§3-4) |
| Protocol | AAS Studio — collection link | Follows from the address: `opc.tcp://` is OPC UA, `modbus+tcp://` is Modbus TCP, `mqtt://` · `mqtts://` is MQTT |
| Tag address (PLC address) | AAS Studio — collection link | One per row: NodeId for OPC UA, register number for Modbus, topic for MQTT (§3-3) |
| Modbus register kind | AAS Studio — collection link | Chosen per row: Holding register · Input register · Coil · Discrete input |
| Modbus conventional address (`40001` …) | AAS Studio — collection link | Type `40001` and a button "40001 → Holding register #0" appears next to it. It converts only when pressed |
| Modbus register count (quantity) | AAS Studio — collection link | Follows from the data type (1, 2 or 4). To read a different count, add `?quantity=2` to the address |
| Data type | AAS Studio — collection link | Modbus: unsignedShort · short · unsignedInt · int · float · double · boolean. OPC UA and MQTT: float · integer · string · boolean |
| Modbus byte and word order | AAS Studio — collection link (API) | Default: high byte first, high word first. The screen has no field for it (§3-3) |
| Unit | AAS Studio — collection link (API) | The screen has no field. It reaches the read list only when the link is made through the API or comes from an AID that states it |
| Tag name | AAS Studio — collection link | Name it like the model element (idShort), so the standard API puts the value on that element |
| Read interval | AAS Studio server | 5 s by default — or `COLLECT_INTERVAL` when the server runs with `COLLECT=on` · `COLLECT_INTERVAL=<s>`. Per machine or tag: `intervals` on the approve API (100 ms – 1 h, [contract.md](contract.md) §8). The approve buttons on the screen approve with the default |
| OPC UA security (Sign · SignAndEncrypt) and user-name sign-in | AAS Studio — collection link | The AID must state it (`securityDefinitions`). A link made on the screen states none, so it connects with **security None, anonymous** |
| PLC user name and password | Label on the server, value on the factory PC | The read list carries only a label (`credentialRef` = that machine's endpoint); the value stays in `credentials.json` on the factory PC (§12-3). OPC UA only |
| MQTT user name and password | AAS Studio — collection link | Part of the address (`mqtt://user:password@host:1883`), so it stays in the server's equipment file (§3-9) |
| Collection mode (read every interval · OPC UA subscription), deadband, resend interval | Factory PC — `edge.json` | `opcua.mode` · `opcua.deadband` · `opcua.resendMs` (§13) |
| Batch interval · queue size | Factory PC — `edge.json` | `flushIntervalMs` · `maxQueuedBatches` · `maxQueueDays` (§11) |
| Server address · proxy · private CA · OPC UA certificates | Factory PC — `edge.json` | §11 · §12 |

**There are no vendor-specific protocols.** Protocols such as LS XGT's FEnet are not read. Turn on the PLC's (or its
communication module's) **Modbus TCP server** or **OPC UA server** and link to that. The server's read list can also
carry HTTP equipment, but VEXPLOR Edge 1.0.1 reads only OPC UA, Modbus TCP and MQTT (HTTP equipment shows "Machine
connection error: HTTP is not read by this edge yet").

### 3-2. The whole trip — from the equipment file to the server's screen

```mermaid
flowchart LR
  AID["AAS Studio<br/>collection link (AID) in the equipment file<br/>address · register · data type"] -- "server turns it into" --> LIST["Read list<br/>addresses · tags · intervals"]
  PERSON["Person"] -- approves --> LIST
  LIST -- "asked every 60 s<br/>(10 s while pending)" --> EDGE["Factory PC<br/>VEXPLOR Edge"]
  EDGE -- "reads only, every interval" --> PLC["PLC · controller"]
  EDGE -- "signed batch every 5 s<br/>(on disk first)" --> SERVER["AAS Studio server<br/>checks · stores"]
  SERVER --> OUT["Collect pane · REST live values<br/>OPC UA publishing · MES · ERP integration"]
```

1. A person makes a collection link (AID) in an equipment file in AAS Studio — the equipment address and the tags to read
2. The server gathers the collection links of the files its workspace owns into a "read list". The list carries
   addresses and registers, never passwords
3. A person approves the list (§6)
4. The collector takes the approved list, connects to the equipment and reads at the set intervals
5. It batches what it read, signs the batch and sends it; the server checks that each tag is approved and stores it
6. The values show in the equipment file's Collect pane and go out exactly like values from the server's own collector

### 3-3. Addresses and tags by protocol

Open the equipment file and, in **← Collect — read from the equipment** on the right, press **Create collection link**.
Put the equipment's address in field ①, then add tags one row at a time with **+ Enter manually**, or tags that differ
only by a number with **+ Many from a pattern**. For OPC UA, **Load from equipment** can also fetch the machine's tag
list — but that button connects from the server, so it does not work when the server is outside the factory (§3-4).
Press **Create** when done. The full screen walkthrough is in the AAS Studio usage guide
[§8-1](https://github.com/waceinc/vexplor-aas/blob/main/docs/usage.md#8-1-create-a-collection-link).

**OPC UA**

| Field | Format | Example |
|---|---|---|
| Endpoint | `opc.tcp://host:port[/path]` | `opc.tcp://192.168.10.21:4840` |
| Tag address | NodeId | `ns=1;s=Machine.MotorSpeed` · `ns=2;i=1005` |
| Data type | float · integer · string · boolean | float for measurements, integer for counters |

All tags of one machine are read in a single request. The timestamp the device puts on a value is kept; a tag the device
reports as "no value yet" (`BadWaitingForInitialData` and the like) is not sent. Other bad states are sent as an empty
value with the status name (e.g. `BadNodeIdUnknown`).

**Modbus TCP**

| Field | Format | Example |
|---|---|---|
| Endpoint | `modbus+tcp://host:port/unitID` — port defaults to 502, unitID to 1 | `modbus+tcp://192.168.10.30:502/1` |
| Tag address | Register number, starting at 0. A unitID may go in front (`1/40`); `?quantity=n` at the end reads n registers | `40` · `1/40` · `1/40?quantity=2` |
| Register kind | Holding register · Input register · Coil · Discrete input | Chosen per row; default Holding register |
| Data type | Table below | Chosen per row; default unsignedShort |

| Data type | Registers read | Value |
|---|---|---|
| unsignedShort · short | 1 | 0 – 65535 · −32768 – 32767 |
| unsignedInt · int · float | 2 | 32-bit integer · 32-bit float |
| double | 4 | 64-bit float |
| boolean | 1 | A register is true when not 0; a coil or discrete input is its bit |

- **Conventional addresses.** Addresses whose first digit is the kind — `40001` · `30010` · `00005` · `10003` from a PLC
  manual — must not be used as they are. Type one in the address field and a button such as "40001 → Holding register #0"
  appears; pressing it converts to the kind and a register number starting at 0. Without pressing it, `40001` is read
  as register number 40001 — the wrong register, or an empty value on a device that has no such number (measured in §3-8)
- **Byte and word order.** The default is high byte first, high word first (big-endian). If floats or 32-bit integers
  come out as nonsense, the PLC sends the low word first. The screen has no field for this, so make the collection link
  through the AAS Studio API `POST /packages/{id}/aid` with `"form": { "modv_mostSignificantWord": "false" }` on each
  tag (`"unit"` can be given the same way)

**MQTT**

| Field | Format | Example |
|---|---|---|
| Endpoint | `mqtt://[user:password@]host:port` — port defaults to 1883; `mqtts://` is TLS on 8883 | `mqtt://broker.plant.local:1883` |
| Tag address | Topic, without wildcards such as `+` · `#` | `plant/press1/temp` |
| Data type | float · integer · string · boolean | |

With MQTT the devices push; the collector does not ask. It subscribes to the topics when it connects and, every
interval, takes **the last value received on each topic**. A topic that has never had a message is not sent. Values are
taken from the message body like this:

| Body | Value |
|---|---|
| `61.2` · `true` | The number or boolean as is |
| `{"value": 61.2}` | The `value` field |
| Text that is not JSON, such as `RUN` | The text as is |
| JSON without `value`, such as `{"temp": 61.2}` | The whole body as text — refused by the server (`TypeMismatch`) when the data type is float or integer |

### 3-4. Equipment addresses are as seen from the factory PC — when the server is outside the factory

What works and what does not for each server location is summed up first in [the pictures in §1-2](#1-2-the-three-cases-in-pictures) and the table in §1-3. This section is the detail for whoever installs.

The collector connects to the read list's addresses **directly from the factory PC**. So the address in a collection link
is the one the factory PC reaches, not one the server can see — usually the private address inside the factory, such
as `192.168.x.x`, as it is.

When the server is in the cloud or at head office, two buttons on the AAS Studio screen cannot reach that address,
because both connect **from the server**:

| Button | When the server is outside the factory | Instead |
|---|---|---|
| **Load from equipment** (browse OPC UA tags) | The server cannot reach the factory address and shows an error. It does not go through the collector | Enter NodeIds with **+ Enter manually** · **+ Many from a pattern**. Get the NodeIds from the PLC vendor's tag list or from an OPC UA client program on a PC inside the factory. If you can run AAS Studio inside the factory network, make the collection link there with Load from equipment and upload that equipment file (AASX) to the server |
| **Collect** (read once now) | Shows "Connection failed" | No need to press it. Values from the remote collector arrive in the Collect pane by themselves (§7) |

If the server itself also collects automatically (`COLLECT=on` · `COLLECT_INTERVAL`), it fails to read those addresses
and the Collect pane shows "Connection failed (auto)". That takes precedence over the remote collector's "Receiving", so
on a server that relies on remote collectors, leave `COLLECT_INTERVAL` unset. Read intervals can be set with
`intervals` on the approve API instead (§3-1).

### 3-5. What the collector does after approval

1. **Fetch the list.** It fetches the read list at start and asks again every 60 s (every 10 s while waiting for
   approval). An unchanged list is answered with "not modified" (304). When a batch answer names a different list
   revision, it asks right away instead of waiting. A changed list closes every equipment connection and opens them again
   from the new list
2. **Connect.** One connection per machine (collection link). OPC UA connects as soon as the list arrives (failing after
   5 s), Modbus TCP connects on the first read, MQTT connects to the broker and subscribes to the topics
3. **Read every interval.** Tags with the same interval are read together. If the previous read has not finished, that
   round is skipped. With `opcua.mode` set to `"subscribe"` in `edge.json`, OPC UA is not polled; only changes come in
   (§13)
4. **Record values.** Each value carries the tag id, value, quality, device time and received time. Device time is the
   device's timestamp for OPC UA, the time the message arrived for MQTT, and the time of reading for Modbus. A tag with no
   value yet is left out; a tag that could not be read is sent empty — the collector never makes values up
5. **Batch and send.** Every 5 s (`flushIntervalMs`) the values become one batch, written to the factory PC's disk first.
   A batch holds up to 5,000 values. Batches are then signed with this PC's key and sent over HTTPS oldest first; only
   those the server acknowledged are deleted. Even with no values, an empty batch goes out once a minute as a sign of
   life. When the line drops: §14

### 3-6. After the server receives a batch

- **Checks.** The signature, then for each value whether it is a tag of the approved list and whether its type fits
  (text for a float or integer tag is `TypeMismatch`). Values that fail are left out and the rest are taken; a batch
  that arrives twice is stored once
- **Storage.** Values are not written back into the equipment file (AASX); they go to the server's value store with the
  equipment file, collection link, tag name and address — the same place values from the server's own collector go
- **Screen.** The equipment file's Collect pane shows the latest value and time, with **Receiving** while values came in
  the last 3 minutes (§7). The Remote collectors window shows last received, values received and machine connections
  (§8)
- **Other systems.** Values go out exactly like those from the server's own collector:

| How | Where |
|---|---|
| Live values on the standard API (`?live=true`) | AAS Studio usage guide [§8-5](https://github.com/waceinc/vexplor-aas/blob/main/docs/usage.md#8-5-exposing-current-values-to-other-systems-rest) |
| AAS Studio serving them as an OPC UA server | AAS Studio usage guide [§8-6](https://github.com/waceinc/vexplor-aas/blob/main/docs/usage.md#8-6-serving-values--the-tool-becomes-an-opc-ua-server) |
| State · alarm · count events to MES · ERP · CMMS | AAS Studio usage guide [§8-7](https://github.com/waceinc/vexplor-aas/blob/main/docs/usage.md#8-7-connecting-mes--erp--cmms) |

### 3-7. Example 1 — press line 1, OPC UA, three tags

Press 1's PLC has an OPC UA server at `opc.tcp://192.168.10.21:4840` inside the factory, and you want motor speed,
production count and the alarm.

1. **Create the collection link.** On the server, open the "Press 1" equipment file and press **Create collection link**.
   Put `opc.tcp://192.168.10.21:4840` in field ①. The server is outside the factory, so instead of **Load from
   equipment**, add three rows with **+ Enter manually** and press **Create**

   | Name | NodeId | Data type |
   |---|---|---|
   | MotorSpeed | `ns=1;s=Machine.MotorSpeed` | float |
   | CycleCount | `ns=1;s=Machine.CycleCount` | integer |
   | AlarmActive | `ns=1;s=Machine.AlarmActive` | boolean |

2. **Connect command.** **Settings ▾ → Remote collectors (VEXPLOR Edge)** → **+ Connect a collector**. Check that the list
   shows this machine · OPC UA · 3 tags, keep **Approve this list so it reads at once** on and press **Make the connect command** (§5-1)
3. **Paste on the factory PC.** Paste the line from **Copy command** into the factory PC's terminal (§5-4). When the
   registration line says `its read list is already approved`, approval is done too
4. **The list the collector receives.** The approved list looks like this (no passwords; the default interval of 5 s)

   ```json
   { "interfaceName": "InterfaceTemplateForOPCUA", "protocol": "OPCUA",
     "endpoint": "opc.tcp://192.168.10.21:4840", "security": { "mode": "None" }, "intervalMs": 5000,
     "tags": [
       { "propertyName": "MotorSpeed",  "address": "ns=1;s=Machine.MotorSpeed",  "type": "float" },
       { "propertyName": "CycleCount",  "address": "ns=1;s=Machine.CycleCount",  "type": "integer" },
       { "propertyName": "AlarmActive", "address": "ns=1;s=Machine.AlarmActive", "type": "boolean" } ] }
   ```

5. **Check the values.** The Remote collectors window shows **Receiving** and "Machines connected 1/1", and the equipment
   file's Collect pane gets the three values every 5 s. On the factory PC, `journalctl -u vexplor-edge` shows
   `read list … (approved): 1 interface(s)`

Measured (2026-10-18, in this repository's interop setup — the real AAS Studio server code and its OPC UA test server,
with the address at `127.0.0.1`): two values per tag in 12 s, MotorSpeed `1200.5` · CycleCount `5200` · AlarmActive
`false`, quality `Good`, stored with both device time and received time.

### 3-8. Example 2 — Modbus TCP

The same machine over Modbus TCP: hydraulic oil temperature (holding registers 10 – 11, float), production count
(holding register 20) and the run signal (coil 0). Put `modbus+tcp://192.168.10.30:502/1` in field ①, then add rows with
**+ Enter manually** and choose the register kind and data type on each row.

| Name | Address | Register kind | Data type | Measured |
|---|---|---|---|---|
| OilTemp | `10` | Holding register | float | `23.5` |
| ProductionCount | `20` | Holding register | unsignedShort | `1234` |
| Running | `0` | Coil | boolean | `true` |
| (wrong) | `40011` — conversion button not pressed | Holding register | unsignedShort | empty (the test device has no register 40011) |

If the PLC manual lists the value as "40011", type `40011` in the address field and press the "40011 → Holding register
#10" button next to it to turn it into `10`. Measured in this repository's interop setup with AAS Studio's Modbus test
device (2026-10-18).

### 3-9. Things to know

- **From 1.0.1 a lost equipment connection comes back by itself.** If the PLC was off when the collector took the list,
  or a PLC or MQTT broker restarts while it reads, the collector does not need a restart. When opening fails, or three
  reads in a row come back all errors, it closes that connection and opens it again after 1 s; if that fails, after 2 s,
  4 s, 8 s … never more than 60 s (each delay shortened a little at random, so many collectors do not knock at once). Once
  a read succeeds the delay starts again from 1 s. While it is down the screen shows "Machines connected 0/1" and
  "Machine connection error: …", and other machines are read as before. With a 5 s interval it takes about 15 s to notice.
  The factory PC log gets one line `… reconnecting in 1 s (backoff up to 60 s)` and one line
  `… connected again after N attempt(s)` (measured for OPC UA, Modbus TCP and MQTT, including a PLC switched on late).
  **1.0.0 does not reconnect** — after a drop it stays **Receiving** with empty values. After turning a PLC or broker back
  on, run `sudo systemctl restart vexplor-edge` on the factory PC
- **The reason a read failed is not always on the screen.** OPC UA empty values carry a status name (`Bad…`); Modbus TCP
  and MQTT show only an empty value. Check the address, register kind, data type and conventional-address conversion
  first
- **MQTT passwords stay on the server.** They are part of the address, so they are in the equipment file and the read
  list. The factory PC's `credentials.json` is used for OPC UA only. Use a separate read-only account
- **An OPC UA collection link made on the screen is security None, anonymous.** A PLC that needs `Sign` ·
  `SignAndEncrypt` or a user-name sign-in needs an AID that states its security (§12-3 · §12-4)

## 4. On the server — turn on remote collection

### 4-1. Open the Remote collectors window

In AAS Studio's header, **Settings ▾ → Remote collectors (VEXPLOR Edge)**. When remote collection is off it looks like
this; an admin presses **Turn on remote collection**.

![Remote collection off — "Turn on remote collection"](images/manual/en/m02-off.png)

Once on, the window shows **+ Connect a collector** and the list of connected collectors.

The server setting `EDGE` decides whether it can be switched:

| `EDGE` | The window |
|---|---|
| empty (default) | Starts off; an admin turns it on here. It stays on across restarts |
| `on` | Always on. No switch on the screen |
| `off` | No remote collection on this server. The window says the remote collector is off, and the collector API (`/edge/v1`) is not served |

A demo-mode server and a server older than 2.7.0 look like `off`.

### 4-2. Make the read list — collection links (AID) in equipment files

A collector reads the collection links (AID, the AssetInterfacesDescription submodel) of the equipment files on the
server. Open an equipment file and, on the right, **Collect → Create collection link**. How to write addresses, registers
and data types, and what to watch when the server is outside the factory, is in §3; the full screen walkthrough is in
the AAS Studio usage guide: [§8-1](https://github.com/waceinc/vexplor-aas/blob/main/docs/usage.md#8-1-create-a-collection-link).

Without any collection link the connect card says "No tags to read yet". You can still connect, and approve later
once a link exists.

## 5. One-click connect

### 5-1. Make the connect command

Press **+ Connect a collector**, check three things and press **Make the connect command**.

![Connect card — server address, approve now, read list](images/manual/en/m04-card.png)

| Field | Details |
|---|---|
| Address of this server, as the factory PC reaches it | Filled with the browser's address. If the factory PC sees the server under another name (internal domain, public address), change it |
| Approve this list so it reads at once | On: the list as it is now is approved with the command, and the PC reads as soon as it connects (§6) |
| The list | Each machine (collection link) with its protocol and tag count |

A command works **once**, for 24 hours. It cannot connect a second PC — make one command per PC.

### 5-2. Addresses that would not work

The card stops addresses the factory PC could not use before a command is made:

- `localhost` / `127.0.0.1` point at this computer itself — a warning tells you the factory PC cannot reach it
- `http://` addresses are refused by the collector, so the button is disabled until the address is `https://`

### 5-3. A factory behind a proxy

If the factory PC goes out only through a site proxy, press **Need a proxy?** and enter it. The
command gets `--proxy`. The collector uses an HTTP CONNECT proxy.

### 5-4. Paste it on the factory PC

Press **Copy command**.

![The connect command and "Copy command" — waiting for the factory PC](images/manual/en/m07-command.png)

Paste it into a terminal on the factory Linux PC. It asks for the admin password once.

```bash
curl -fsSL https://github.com/waceinc/vexplor-edge/releases/latest/download/get.sh | sudo sh -s -- --server https://aas.factory-cloud.example --code AA6B-CYFF-DWZE
```

That one line:

1. downloads the package for the PC's CPU (x64 · arm64) from the latest release
2. checks it against that release's `SHA256SUMS` — on a mismatch it stops without installing
3. puts the program in `/opt/vexplor-edge` and the configuration in `/etc/vexplor-edge/edge.json`
4. makes a signing key on this PC and registers with the code
5. turns on the systemd service `vexplor-edge`, which starts again at every boot

Real output (clean Ubuntu, arm64):

```text
VEXPLOR Edge 1.0.0 (linux-arm64) — downloading
checked against SHA256SUMS
{"time":"2026-10-18T05:18:06.922Z","level":"info","message":"registered as dev_8760c38b60d8a808 — its read list is already approved; it reads as soon as the service starts"}
installed and started: systemctl status vexplor-edge · journalctl -u vexplor-edge
Done. Open the server's 「원격 수집기 (Remote collectors)」 screen: this PC shows as Receiving once values arrive.
If the list was not approved with the command, approve it there — it reads nothing before that.
```

Options you can add:

| Option | Meaning |
|---|---|
| `--proxy http://host:port` | Site proxy (§5-3) |
| `--ca-file corp-ca.pem` | The certificate of a private CA that issued the server's certificate (§12-2) |
| `--credentials-file credentials.json` | PLC user names and passwords (§12-3) |
| `--name "Line 1"` | Name shown on the server. Default: the PC's hostname |
| `--no-service` | Do not register a service (tests · containers) |

### 5-5. Check the connection

The moment the PC registers, the card shows it — while waiting it reads the device list every 3 s. Press **Done**; a
green **Receiving** means the connection is complete.

![Connected collectors](images/manual/en/m09-list.png)

## 6. Approval — deciding what a collector reads

A collector reads **only a list a person approved.** Two ways:

| How | When |
|---|---|
| Approve with the command ("Approve this list so it reads at once" on) | Usually. It reads as soon as it is pasted |
| Approve after it connects (off) | When the PC goes in first and the list is settled after a site check |

### 6-1. Approving afterwards

With "approve at once" off, the connected PC shows as **Waiting for approval**. It reads nothing and asks the server every
10 s.

![Connected, waiting for approval](images/manual/en/m11-pending-arrived.png)

**Review and approve** shows the machines, addresses and tag counts it would read; **Approve this list** approves exactly
that.

![The list before approval](images/manual/en/m12-preview.png)

Within 10 s the collector sees the approval and starts reading.

### 6-2. When equipment files change — "Approve again"

After approval, a changed collection link (a tag added, an address changed, a file added) does **not** reach the
collector: it keeps reading the list as approved, so a list never grows by itself. The row says "The files changed after
approval" and offers **Approve again**; review and approve, and it reads the new list from then on.

If someone changed a file between the card being shown and the button being pressed, the server refuses the stale list and
the card shows the new one. Nobody approves a list they have not seen.

## 7. Seeing the values

Values appear in **the equipment file**, not in the Remote collectors window. Open the file: the **Collect** pane on the
right fills every 10 s and shows **Receiving** while the remote collector sends.

![The equipment file's Collect pane — values from the remote collector](images/manual/en/m16-collect.png)

| Shown | Meaning |
|---|---|
| Latest value · time | The last value the collector read from the PLC, and when |
| (empty) + a quality code | The PLC could not give a value (e.g. `BadDeviceFailure`). The collector never makes a value up; it sends the empty value and the reason. Modbus TCP and MQTT show only the empty value, without a quality code (§3-9) |
| Daily status | The day's running · stopped · alarm band |

The same values go out through AAS Studio's REST API (`?live=true`) and integrations (MES · ERP · CMMS) — exactly like
values from the server's own collector.

## 8. Reading a collector's state

The window reads the list again every 10 s.

| Badge | Meaning | What to do |
|---|---|---|
| **Receiving** | A batch arrived in the last 3 minutes | Nothing |
| **Waiting for the first values** | Approved, no batch yet | Wait a minute or two |
| **Waiting for approval** | Connected, list not approved | Review and approve (§6-1) |
| **Paused** | A person paused it | Resume |
| **stale** | Nothing for over 3 minutes | See below |
| **Revoked** | Revoked; cannot be undone | Connect again with a new command |

The line under the name:

| Shown | Meaning |
|---|---|
| Last received | When the server last got a batch |
| values received | Values received and stored from this collector, in total |
| Reading n tags | Tags in the approved list |
| Machines connected n/m | Machines the collector is connected to / machines approved. If short, "Machine connection error: …" gives the reason |
| batches waiting to be sent | Batches that piled up on the PC while the line was down and are going out now (§14) |
| Version | The version the collector reported in its last batch (not the one at registration) |

**stale.** A collector sends a batch at least once a minute, even with nothing new. After 3 minutes with nothing, the row
turns **stale** and says what to check: ① is the PC on ② `systemctl status vexplor-edge` (§10) ③ is the way out (443 ·
proxy) open ④ `journalctl -u vexplor-edge` for `read list not reachable` or `sending paused` (§18). When the line comes
back, the queued batches arrive in order and the row returns to Receiving — values from the outage are not lost.

### 8-1. PC, line and equipment state (collector 1.1.0 and later)

From 1.1.0 every batch also says how the factory PC is doing, how the line to the server is doing and how the equipment
answers (exact definitions: [contract §5.1](contract.md#51-hardware-and-line-state-added-in-edge-110--optional)).
Collectors 1.0.x do not send these values.

| What | Values | Meaning |
|---|---|---|
| PC | `cpuPercent` · `memoryUsedPercent` | CPU and memory in use (%). CPU averaged over the last 30 s; memory on Linux only |
| PC | `diskFreeBytes` · `diskFreePercent` | Free space on the disk that holds the queue — where batches pile up when the line drops (§14) |
| PC | `uptimeSeconds` · `processUptimeSeconds` | Seconds since the PC and since the collector started. A sudden drop means a reboot or a restart |
| PC | `clockOffsetMs` | Server clock minus PC clock (ms) |
| Line | `lastSendOkAt` · `lastSendError` · `sendFailuresSinceOk` | When sending last worked, why it last failed, and how many sends failed since |
| Line | `roundTripMs` · `oldestQueuedAt` | Average time until the server answers (ms) · when the oldest batch not yet sent was made |
| Equipment | `responseMs` · `readOkRatio` | Average time the equipment takes to answer (ms) · share of the last 100 reads that worked |
| Equipment | `reconnects` · `lastDisconnectAt` | Times a lost connection was opened again · when it was last lost |

**When to look closer.** On the server's screen these count as a warning:

| Threshold | Why it matters | What to do |
|---|---|---|
| Less than 10% disk free | Batches queued during an outage have little room. The queue limit (`maxQueuedBatches`, §11) counts batches, not bytes, so watch that the disk does not fill first (§14) | Free or add disk space on the PC; `maxQueuedBatches` can also be lowered |
| Sending has failed for over a minute (`sendFailuresSinceOk` 1 or more, over a minute since the last success) | Values reach the server late | Look up `lastSendError` in §18 |
| Clocks more than 5 s apart (`clockOffsetMs`, either sign) | Value times (`receivedAt`) are off by as much; past 5 minutes the server refuses requests (`ClockSkew`, §18) | Turn on time synchronisation (NTP) on the PC |
| Equipment reads below 90% (`readOkRatio` under 0.9) | Values go missing or the connection drops often | Check power, cables and switches, and read `lastError` and `reconnects`. If `responseMs` is close to the reading interval, lengthen the interval |

While sending keeps failing no batch reaches the server, so the row turns **stale**. The line values help afterwards — to
see why it dropped once it is back — and when sending fails now and then.

## 9. Pause · resume · revoke

| Button | What it does | Undo |
|---|---|---|
| **Pause** | The collector stops reading (at its next list check, within a minute). The approval stays | **Resume** — reads the approved list again |
| **Revoke** | The server refuses every request from it. The collector stops sending and keeps its queue | None. Connect again with a new command |

![A paused collector — "Resume"](images/manual/en/m14-paused.png)

Revoke asks once more. Revoked collectors move under "Revoked collectors". When you replace or retire a PC, revoke it on the
server and remove the program on the PC (§17). The server cannot switch a collector off or delete it remotely — on purpose
(§19).

## 10. On the factory PC — service, log, files

| To | Command |
|---|---|
| See if it runs | `systemctl status vexplor-edge` |
| Follow the log | `journalctl -u vexplor-edge -f` |
| Today's log | `journalctl -u vexplor-edge --since today` |
| Restart (after a configuration change) | `sudo systemctl restart vexplor-edge` |
| Stop | `sudo systemctl stop vexplor-edge` |
| Version | `/opt/vexplor-edge/vexplor-edge --version` |

The log is one JSON object per line (time, level, message). Normal lines:

```text
{"time":"…","level":"info","message":"read list ca22b55e3fe65985 (approved): 1 interface(s)"}
{"time":"…","level":"info","message":"running as dev_8760c38b60d8a808, boot 4be5b497-…"}
```

| Where | What | Access |
|---|---|---|
| `/opt/vexplor-edge/vexplor-edge` | The program (one executable) | root |
| `/etc/vexplor-edge/edge.json` | Configuration (§11) | root writes, service account reads |
| `/etc/vexplor-edge/ca.pem` · `credentials.json` | Private CA · PLC passwords given at install (only if given) | root writes, service account reads |
| `/var/lib/vexplor-edge/identity.json` | Device id and this PC's signing key. **Never leaves the PC** | service account only |
| `/var/lib/vexplor-edge/queue` | Batches waiting to be sent | service account only |
| `/var/lib/vexplor-edge/refused` | Batches the server refused as malformed (kept for a person) | service account only |
| `/var/lib/vexplor-edge/opcua-pki` | OPC UA certificates (§12-4) | service account only |
| `/etc/systemd/system/vexplor-edge.service` | The service | root |

The service runs as its own account `vexplor-edge` with reduced rights — no new privileges, a read-only system, and
`/var/lib/vexplor-edge` as the only place it can write.

## 11. The configuration file `edge.json`

The installer writes three keys:

```json
{ "server": "https://aas.factory-cloud.example", "stateDir": "/var/lib/vexplor-edge", "name": "press-line-1" }
```

Every key (restart after a change):

| Key | Default | Meaning |
|---|---|---|
| `server` | (required) | Server address. **https** only (`http://localhost` on the same PC is the one exception). A wrong address stops the start |
| `stateDir` | (required) | Folder for the key, queue and certificates |
| `name` | `VEXPLOR Edge` | Name shown on the server (the list also shows the hostname) |
| `proxy` | none | HTTP CONNECT proxy, `http://host:port` |
| `caFile` | none | PEM of a private CA that issued the server's certificate |
| `credentialsFile` | none | PLC user names and passwords (§12-3) |
| `opcua.pkiDir` | `<stateDir>/opcua-pki` | OPC UA certificate folder |
| `opcua.trustFirstUse` | `false` | Trust an OPC UA server certificate seen for the first time (§12-4) |
| `opcua.mode` | `"poll"` | `"poll"` (read every interval) or `"subscribe"` (changes only, §13) |
| `opcua.deadband` | `0` | Subscribe: absolute deadband for analog tags |
| `opcua.resendMs` | `300000` | Subscribe: resend an unchanged value this often (5 min) |
| `flushIntervalMs` | `5000` | How often collected values become a batch (5 s — 12 a minute) |
| `maxQueuedBatches` | `100000` | Batches kept on disk at most |
| `maxQueueDays` | `30` | Days an unsent batch is kept |
| `update.manifestUrl` · `update.publicKey` | none | Update notices (§15); both are needed |

Relative paths are relative to the configuration file. Read intervals are not set in this file; the server sends them in
the read list — 5 s by default, and they can differ per machine or tag when approving (§3-1).

## 12. Proxy · private CA · PLC passwords · OPC UA certificates

### 12-1. Proxy

At install `--proxy http://proxy.plant.local:3128` (or the proxy field on the card). To change it later, edit `proxy` in
`edge.json` and restart. The proxy must allow CONNECT to the server on 443; otherwise the log says
`proxy refused CONNECT …: 403`.

### 12-2. Private certificate authority

If a company CA issued the server's certificate, pass its certificate (PEM) with `--ca-file corp-ca.pem`. It is copied to
`/etc/vexplor-edge/ca.pem` and set as `caFile`.

### 12-3. PLC passwords

PLC user names and passwords go neither on the server nor in equipment files. The collection link carries only a name
(`credentialRef`); the values stay in a file on the factory PC:

```json
{ "opc.tcp://10.0.0.5:4840": { "userName": "reader", "password": "…" } }
```

Pass it at install with `--credentials-file credentials.json`; it is copied to `/etc/vexplor-edge/credentials.json`
(readable by root and the service account only). If the named entry is missing, that machine does not connect and the
screen shows "no credential named … in the credentials file".

### 12-4. OPC UA certificates

At first start the collector makes its own certificate in `opcua-pki`. With security mode `Sign` or `SignAndEncrypt`, both
sides must trust each other's certificate:

1. A PLC certificate seen for the first time is refused and put in `/var/lib/vexplor-edge/opcua-pki/rejected`
2. After checking it, move it to `opcua-pki/trusted/certs` and restart
3. On the PLC (OPC UA server), trust the collector's certificate (`opcua-pki/own/certs`)

Where the check can be skipped (an installation test), `"opcua": { "trustFirstUse": true }` trusts the first certificate
seen. Not recommended in production.

## 13. Sending changes only (OPC UA subscriptions · deadband)

By default (`"poll"`) every tag is read and sent at its interval. On a thin line or with many tags, switch to OPC UA
subscriptions:

```json
{ "server": "…", "stateDir": "/var/lib/vexplor-edge",
  "opcua": { "mode": "subscribe", "deadband": 1.0, "resendMs": 300000 } }
```

- `subscribe` — the PLC samples each tag at its interval and reports **changes only**
- `deadband` — analog (float) tags do not send changes smaller than this. **Never applied to counters, states or text**
  (a production count rising by 1 under a deadband of 1 would lose every other step)
- `resendMs` — an unchanged value is sent again this often, so the server can tell "unchanged" from "not reading"

Measured (PLC simulator, 6 tags · 1 s · 5 min):

| Mode | Values sent | Size |
|---|---|---|
| Read every time (`poll`) | 1,794 | 283 KB |
| Subscribe | 729 | 130 KB (−54%) |
| Subscribe + deadband 1.0 | 436 | 88 KB (−69%) |

If a PLC refuses subscriptions, the log says `subscription refused, reading every … ms instead` and the collector keeps
reading at the interval.

## 14. When the line drops — the queue

- Values are first written to disk on the PC (`queue`) as batches; a batch is deleted only after the server confirms it
- When the server does not answer (line down · server restart · 429 · 5xx), the same batch is sent again at growing
  intervals (at most 5 min)
- When the line comes back, the queue goes out **oldest first, in order**. The screen shows "n batches waiting to be sent"
  going down to 0
- The server stores a batch once even if it arrives twice (device · boot · sequence)
- Beyond `maxQueuedBatches` (100,000) or `maxQueueDays` (30 days), the oldest are dropped and the count is reported in the
  next batch's status — never silently
- A batch the server refuses as malformed is moved to `refused` for a person to look at
- A full disk does not stop the collector (from 1.1.0). A batch it cannot write waits in memory and is sent from there,
  and goes to disk once there is room. Memory holds at most 1,000 batches and 100,000 values; beyond that the oldest are
  dropped and the count is reported in the status. A service restart meanwhile loses what is in memory, so free the disk
  first (disk free in §8-1)

## 15. Upgrading · update notices

The collector never downloads or installs anything by itself; a person upgrades it. Registration (key, device id) lives in
`/var/lib/vexplor-edge`, so replacing the program is enough — no new registration, no new approval:

```bash
V=1.0.1    # the version to install
A=x64      # arm64 on an arm64 PC
curl -fsSLO https://github.com/waceinc/vexplor-edge/releases/download/v$V/vexplor-edge-$V-linux-$A.tar.gz
curl -fsSLO https://github.com/waceinc/vexplor-edge/releases/download/v$V/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
tar xzf vexplor-edge-$V-linux-$A.tar.gz
sudo install -m 0755 vexplor-edge-$V/vexplor-edge /opt/vexplor-edge/vexplor-edge
sudo systemctl restart vexplor-edge
/opt/vexplor-edge/vexplor-edge --version
```

The version on the server screen changes with the next batch. What changed in each version:
[Releases](https://github.com/waceinc/vexplor-edge/releases).

**Update notices (optional).** With `"update": { "manifestUrl": "https://…", "publicKey": "<release key>" }` in
`edge.json`, the collector reads a release manifest once a day and, when one signed by that key names a newer version,
reports it in the log (`update available: …`) and in the next batch's status. A manifest with a bad signature is ignored
and logged. Without both settings no update request is ever made.

## 16. Installing on a PC without internet

If the factory PC cannot reach GitHub, download elsewhere and carry the files over:

1. From [Releases](https://github.com/waceinc/vexplor-edge/releases) take `vexplor-edge-<version>-linux-x64.tar.gz` (or
   `linux-arm64`) and `SHA256SUMS`
2. On the factory PC:

```bash
sha256sum -c SHA256SUMS --ignore-missing
tar xzf vexplor-edge-<version>-linux-x64.tar.gz && cd vexplor-edge-<version>
sudo ./install.sh --server https://aas.factory-cloud.example --code AA6B-CYFF-DWZE
```

The code is the `--code` of the command the screen made. `install.sh` takes the same options as `get.sh` (`--proxy` ·
`--ca-file` · `--credentials-file` · `--name` · `--no-service`). The PC still has to reach the server on 443 (or a proxy).

## 17. Removing

On the factory PC:

```bash
sudo systemctl disable --now vexplor-edge
sudo rm -r /opt/vexplor-edge /etc/vexplor-edge /etc/systemd/system/vexplor-edge.service
sudo systemctl daemon-reload
# only to delete the queue and the key as well
sudo rm -r /var/lib/vexplor-edge
sudo userdel vexplor-edge
```

On the server, **revoke** the collector (§9). A PC removed without revoking stays in the list as stale.

## 18. Troubleshooting

**While installing (`get.sh` · `install.sh`)**

| Message | Cause | What to do |
|---|---|---|
| `this installer is for Linux (Windows is in preparation)` | Not Linux | A Linux PC or VM |
| `unsupported CPU: …` | Not x64 or arm64 | A supported PC |
| `run as root` | Run without `sudo` | Paste the command as shown (`| sudo sh …`) |
| `download failed: …` | GitHub not reachable | Behind a proxy, set `https_proxy` and run `sudo -E sh` (sudo drops environment variables by default), or install directly (§16) |
| `… does not match SHA256SUMS — not installed` | The download differs from the release (tampered or damaged) | Nothing was installed. Download again; if it repeats, check the network equipment |
| `quotes and backslashes are not allowed` | Quotes or backslashes in an address or name | Enter them without |
| `registration refused: 401 RegistrationCodeInvalid` | Code wrong, used, or older than 24 hours | Make a new command on the screen |
| `registration refused: 429 RateLimited` | Many registrations in a short time | Try again shortly |
| `server must be https:// (plain http only on this machine)` | Server address is http | An https address (HTTPS in front of the server) |

**While running (`journalctl -u vexplor-edge`)**

| Log · screen | Cause | What to do |
|---|---|---|
| Screen **stale**, log `read list not reachable: …` | The way out to the server is blocked | Check 443, proxy, DNS. Values are being queued |
| `sending paused … ms: no answer: …` | The server does not answer | Check the server. The same batch is sent again |
| `sending paused … ms: 401 ClockSkew` | The PC's clock is over 5 minutes off the server's | Turn on time sync (NTP) |
| `queue: cannot write to disk, keeping batches in memory and sending them from there — ENOSPC …` | The PC's disk is full (from 1.1.0 the collector keeps running) | Free disk space; `queue: writing to disk again` follows once there is room. A restart before that loses the batches in memory |
| `proxy refused CONNECT …` | The proxy blocks the server on 443 | Allow the server address on the proxy |
| `ALARM: read list refused: 403 DeviceRevoked — sending stopped, the queue is kept` | Revoked on the server | If intended, remove it (§17). If not, connect again with a new command |
| `ALARM: … 401 UnknownDevice …` | The server has no record of this device (its data was reset) | Remove (§17) and connect again with a new command |
| `not registered — run register with a code first` | The service started without registration | Make a command on the screen and install again |
| Screen "Machines connected 0/1" · "Machine connection error: …" | The PLC is unreachable or refuses | PLC address, port firewall, OPC UA certificates (§12-4), passwords (§12-3). From 1.0.1 the collector retries at most every 60 s, so once the PLC is fixed it is read again by itself (§3-9) |
| Log `… reconnecting in … s` · `reconnect attempt N failed` | A PLC or broker went off or restarted (1.0.1 and later) | Once it is on, `connected again` is logged and reading resumes. If it keeps failing, see the row above |
| After a PLC or broker came back, **Receiving** but only empty values (1.0.0) | 1.0.0 does not reconnect a lost equipment connection | `sudo systemctl restart vexplor-edge`, or update to 1.0.1 or later (§15) |
| Screen stays "Waiting for approval" | Not approved | Review and approve (§6-1) |
| Screen "The files changed after approval" | A collection link changed | Approve again (§6-2) |
| (empty) + `Bad…` in a value | The PLC could not give that tag | Check the tag on the PLC — not a collector problem |

**On the server screen**

| Screen | Cause | What to do |
|---|---|---|
| "Remote collectors are off on this server" | `EDGE=off`, demo mode, or a server older than 2.7.0 | The server admin empties `EDGE` or sets `on` and restarts |
| "Sign in with an admin account to turn it on here." | Not an admin account | An admin turns it on |
| "The server setting EDGE decides this." | `EDGE` fixed to `on`/`off` | Change the server setting |
| "Make the connect command" disabled | Address is http or malformed | §5-2 |
| Making a command or approving fails with "the list changed" | An equipment file changed meanwhile | The card / preview shows the new list; check it and press again |

**Help.** AAS Studio's **? Help** has a short "Remote collectors (VEXPLOR Edge) — one-click connect" topic with the same
flow.

## 19. Security — what it does and does not do

| | |
|---|---|
| **Read only** | No code writes to a PLC or controller. Reading uses the same libraries as the collector inside AAS Studio |
| **Outbound only** | Only to the server address on 443 (or a proxy). It opens no port; the server has no way into the factory |
| **Approved list only** | Only the list a person approved. A changed list is not read until it is approved again |
| **Every request signed** | An Ed25519 key is made on the PC at registration and signs every request. The private key never leaves the PC |
| **Passwords stay on the PC** | PLC passwords are only in a file on the factory PC; the server, equipment files and read list carry only a name |
| **No remote stop** | The server sends the collector no commands. Revoking means the server refuses its requests; the collector stops by itself |
| **No automatic install** | New versions can only be announced; a person installs them |

Every destination it connects to:

| Destination | Why | When |
|---|---|---|
| The configured server on 443 (or `proxy`) | Registration · read list · batches | Always |
| PLC addresses in the approved list (OPC UA · Modbus TCP · MQTT) | Reading values | After approval |
| `update.manifestUrl` | Update notice, once a day | Only if configured |
| GitHub releases | Downloading the package (`get.sh`) | Only while installing |

Found a security problem? See [SECURITY.md](../SECURITY.md).

## Appendix. Terms

| Term | Meaning |
|---|---|
| Collector · device | One VEXPLOR Edge on a factory PC. The server records it by device id (`dev_…`) |
| Registration code | `XXXX-XXXX-XXXX` made by the screen. 24 hours, once |
| Read list | Machines and tags to read, made by the server from the collection links (AID) of equipment files |
| Approval | A person deciding "this list may be read" after seeing it. Bound to the list's revision |
| Batch | Values collected over 5 s, signed and sent together |
| Queue | Where unsent batches wait on the factory PC's disk |
| Contract `vexplor.edge/1` | What the collector and the server exchange — [contract.md](contract.md) |
