**English** · [한국어](CONTRIBUTING.ko.md)

# Contributing to VEXPLOR Edge

Thank you for helping. A few rules keep the collector safe to run inside a factory.

1. **Read only, outbound only.** No change may write to a PLC, open a listening port, run a command, or act on a
   command from the server. `test/safety.test.ts` reads the source and fails if any of these appears.
2. **The contract is `vexplor.edge/1`.** Changes are additive (new optional fields). Anything that is not goes to a new
   contract (`vexplor.edge/2`). This repository holds the canonical text (`docs/contract.md`, `docs/schemas`,
   `docs/examples`); VEXPLOR AAS Studio keeps the copy its server follows, and the interop tests check both match.
3. **Tests first for bugs** — a test that fails without the fix, then the fix.
4. **Comments in English**, user-facing text in English and Korean.

## Running

```bash
npm ci && npm run typecheck && npm run build && npm test
AAS_DIR=../vexplor-aas npm run test:interop   # needs a built checkout of waceinc/vexplor-aas
```

## Releasing a version

When `EDGE_VERSION` (`src/version.ts`) goes up, the same release updates everything that describes the collector — a
release is not done while any of these still shows the old version or misses what changed:

1. **Version strings** — `src/version.ts`, `package.json`, the "Versions" table in both READMEs.
2. **What changed** — the README table and the guide that covers it (`docs/install.md` · `docs/설치.md`, the contract),
   in English and Korean.
   Add the new version's row with a filled "What changed" cell, and the same row on top of the "What changed in each version"
   table on the wace.me Edge page (`chg` in `wace-home/scripts/build-edge-page.py`, Korean, English, Japanese) and the
   "Versions" section of the project page. Older rows stay; the daily check compares these rows too.
3. **Release** — `npm run pack:release`, tag `vX.Y.Z`, attach both Linux packages, `get.sh` and `SHA256SUMS`. The
   one-line install always fetches `releases/latest/download/get.sh`, which is pinned to its own release.
4. **Website** — the VEXPLOR Edge page on wace.me (Korean, English, Japanese) and the project page on the `gh-pages`
   branch (waceinc.github.io/vexplor-edge): version label and what changed. Whoever bumps the version writes the text,
   checked against the code. A daily check compares the latest release with the README and the website.
   Search and AI answers read two more places on wace.me: the `softwareVersion` in each product page's structured data
   and the version on the project cards of `/opensource` — both are generated from `VERSIONS` in
   `wace-home/scripts/oss_seo.py` (the site repository's README has the four commands; the Edge page's own version text is in `build-edge-page.py`). Run them twice before
   deploying and check nothing changes the second time, then announce the changed URLs with IndexNow.

Contributions are distributed under this repository's [Apache License 2.0](LICENSE).
