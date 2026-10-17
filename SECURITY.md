**English** · [한국어](SECURITY.ko.md)

# Security policy

## If you found a vulnerability

**Do not open a public issue.** Until it is fixed, publishing it puts the factories running this collector at risk.

Report it through this repository's **Security → Report a vulnerability** (GitHub private vulnerability reporting).
These details help us confirm it quickly:

- what you did and what happened (steps to reproduce)
- which version (`vexplor-edge --version`, or the commit)
- how it was installed (get.sh / by hand) and which server it connects to

We confirm and reply as soon as possible. After the fix we credit the reporter (or leave the name out if you prefer).

## Supported versions

Only the latest version receives security fixes. Please upgrade older versions.

## What the collector is built to hold

- It opens no port and accepts no connection; it only connects out to its server (and, when configured, the update
  notice source).
- It reads only what a person approved on the server and never writes to a device.
- Every request carries an Ed25519 signature made with a key that is created on the PC and never leaves it.
- Packages are checked against `SHA256SUMS` by `get.sh` before anything runs; the Windows package is not offered yet.
