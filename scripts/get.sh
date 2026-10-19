#!/bin/sh
# VEXPLOR Edge — download, check and install in one line. This is the command the 「원격 수집기」 screen of
# VEXPLOR AAS Studio shows, with the server and a one-time code already filled in:
#
#   curl -fsSL https://github.com/waceinc/vexplor-edge/releases/latest/download/get.sh \
#     | sudo sh -s -- --server https://aas.example.com --code 7KQ4-M2XD-9PRT [--proxy http://proxy:3128] [--name "Line 1"]
#
# It takes the package for this PC's CPU from the same release as this script, checks it against that release's
# SHA256SUMS, and runs the installer inside (install.sh — every option is passed on). Linux x64 and arm64.
set -eu

REPOSITORY="https://github.com/waceinc/vexplor-edge"
VERSION="__EDGE_VERSION__"

fail() { echo "vexplor-edge: $1" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || fail "this installer is for Linux - on Windows use the Windows tab (get.ps1)"
case "$(uname -m)" in
  x86_64|amd64) PLATFORM="linux-x64" ;;
  aarch64|arm64) PLATFORM="linux-arm64" ;;
  *) fail "unsupported CPU: $(uname -m) (x64 and arm64 are supported)" ;;
esac
[ "$(id -u)" -eq 0 ] || fail "run as root: … | sudo sh -s -- --server … --code …"
command -v curl >/dev/null 2>&1 || fail "curl is needed"
if command -v sha256sum >/dev/null 2>&1; then SUM="sha256sum"; elif command -v shasum >/dev/null 2>&1; then SUM="shasum -a 256"; else fail "sha256sum is needed"; fi

PACKAGE="vexplor-edge-${VERSION}-${PLATFORM}.tar.gz"
BASE="${REPOSITORY}/releases/download/v${VERSION}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "VEXPLOR Edge ${VERSION} (${PLATFORM}) — downloading"
curl -fsSL --proto '=https' "${BASE}/${PACKAGE}" -o "${WORK}/${PACKAGE}" || fail "download failed: ${BASE}/${PACKAGE}"
curl -fsSL --proto '=https' "${BASE}/SHA256SUMS" -o "${WORK}/SHA256SUMS" || fail "download failed: ${BASE}/SHA256SUMS"
EXPECTED=$(grep " ${PACKAGE}\$" "${WORK}/SHA256SUMS" | cut -d' ' -f1)
ACTUAL=$(cd "$WORK" && $SUM "$PACKAGE" | cut -d' ' -f1)
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || fail "${PACKAGE} does not match SHA256SUMS — not installed"
echo "checked against SHA256SUMS"

tar -xzf "${WORK}/${PACKAGE}" -C "$WORK"
"${WORK}/vexplor-edge-${VERSION}/install.sh" "$@"
