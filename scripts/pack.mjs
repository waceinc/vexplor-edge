/**
 * Packs the remote collector as one executable per platform, with its installer and the one-line downloader.
 *
 *     npm run build && node scripts/pack.mjs             # → out/vexplor-edge-<version>-linux-x64.tar.gz + get.sh + SHA256SUMS
 *     npm run build && node scripts/pack.mjs --arm64     # + vexplor-edge-<version>-linux-arm64.tar.gz
 *     npm run build && node scripts/pack.mjs --windows   # + vexplor-edge-<version>-win-x64.zip + get.ps1 (1.2.0)
 *     npm run build && node scripts/pack.mjs --windows --no-linux   # Windows only — what a Windows machine can build
 *
 * 1. rolldown bundles dist/bin.js and everything it imports into one CommonJS file.
 * 2. The packages that actually went into the bundle become THIRD-PARTY-NOTICES.txt and a CycloneDX SBOM — the list is
 *    what was bundled, not what package.json declares.
 * 3. Node.js single executable (SEA): a blob made with the same Node version as the targets, injected with postject into
 *    the official Linux and Windows binaries. Every download is checked — Node against the official SHASUMS256.txt,
 *    WinSW against the hash pinned below.
 * 4. Each package holds the executable, the installer (install.sh + systemd unit / install.ps1 + WinSW), an example
 *    configuration, LICENSE, NOTICE, the notices, the SBOM and licenses/ — the license texts of Node.js and WinSW.
 *
 * Important: Windows is offered from 1.2.0 (`pack:release` passes --windows). Its service wrapper is WinSW, because Node
 *    cannot answer the Windows service manager itself (install/install.ps1).
 * Important: Linux packages are built on Linux or macOS only — a Windows file system keeps no executable bit, and a
 *    package made there would hold a collector that does not start. On Windows only --windows --no-linux is accepted.
 * Important: the Windows executable is not code-signed — signing needs a certificate (a purchase; plan §10-4). Until
 *    then the package is verified by SHA256SUMS.
 * Important: WinSW publishes no digest for v2.12.0; the hash below was taken at its first download (2026-10-16) and is
 *    the one every later build must match.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipSync, zipSync } from 'fflate';
import { rolldown } from 'rolldown';

// fileURLToPath, not URL.pathname — on Windows the pathname is /D:/… and would not resolve
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'out');
const CACHE = join(OUT, 'cache');
const NODE_VERSION = 'v24.21.0'; // Node 24 LTS, the newest patch at least two weeks old when chosen (2026-10-16)
const WINSW = { url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe', sha256: '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da' };
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
/** Packages whose package.json names no license, read from their own files (2026-10-16) */
const LICENSE_READ = { dequeue: 'BSD-2-Clause' /* LICENSE file */, precond: 'MIT' /* README "License" */ };
/** Runtime copyleft is refused (scripts/ci.sh step 7 holds the server to the same rule) */
const REFUSED_LICENSE = /GPL|SSPL|BUSL|Commons-Clause/i;

const version = /EDGE_VERSION = '([^']+)'/.exec(readFileSync(join(ROOT, 'src/version.ts'), 'utf8'))[1];
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const fail = (message) => {
  process.stderr.write(`[FAIL] ${message}\n`);
  process.exit(1);
};

async function download(url, file) {
  if (existsSync(file)) return file;
  const response = await fetch(url);
  if (!response.ok) fail(`download ${url}: ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

/** Bundles the edge and returns the bundled third-party packages */
async function bundle(file) {
  if (!existsSync(join(ROOT, 'dist/bin.js'))) fail('dist is missing — run npm run build first');
  const build = await rolldown({ input: join(ROOT, 'dist/bin.js'), platform: 'node', external: (id) => id.startsWith('node:'), logLevel: 'silent', treeshake: true });
  const { output } = await build.generate({ format: 'cjs', codeSplitting: false });
  await build.close();
  writeFileSync(file, output[0].code);
  const packages = new Map();
  for (const id of Object.keys(output[0].modules)) {
    const at = id.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const rest = id.slice(at + 'node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    if (packages.has(name)) continue;
    const manifest = JSON.parse(readFileSync(join(id.slice(0, at), 'node_modules', name, 'package.json'), 'utf8'));
    const license = typeof manifest.license === 'string' ? manifest.license : LICENSE_READ[name];
    // An unknown license is a question for a person, not a line in a notices file
    if (!license) fail(`${name}@${manifest.version}: no license in package.json — read it and add it to LICENSE_READ`);
    if (REFUSED_LICENSE.test(license)) fail(`${name}@${manifest.version} is ${license} — not allowed in the edge package`);
    packages.set(name, { name, version: manifest.version, license });
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function notices(packages, extra) {
  const lines = [`VEXPLOR Edge ${version} — third-party software in this package`, ''];
  for (const entry of [...packages, ...extra]) lines.push(`${entry.name} ${entry.version} — ${entry.license}`);
  return `${lines.join('\n')}\n`;
}

function sbom(packages, extra) {
  return JSON.stringify(
    {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      metadata: { component: { type: 'application', name: 'vexplor-edge', version } },
      components: [...packages, ...extra].map((entry) => ({ type: 'library', name: entry.name, version: entry.version, licenses: [{ license: { id: entry.license } }] })),
    },
    null,
    2,
  );
}

/** Downloads and checks the official Node binary for one platform; returns the path of node / node.exe */
async function nodeBinary(platform, sums) {
  const archive = platform === 'win-x64' ? `node-${NODE_VERSION}-win-x64.zip` : `node-${NODE_VERSION}-${platform}.tar.gz`;
  const file = await download(`https://nodejs.org/dist/${NODE_VERSION}/${archive}`, join(CACHE, archive));
  const expected = sums.get(archive);
  if (!expected || sha256(file) !== expected) fail(`${archive} does not match SHASUMS256.txt`);
  const dir = join(CACHE, archive.replace(/\.(zip|tar\.gz)$/, ''));
  const exe = platform === 'win-x64' ? join(dir, 'node.exe') : join(dir, 'bin/node');
  if (!existsSync(exe) || !existsSync(join(dir, 'LICENSE'))) {
    // GNU tar reads no zip; node.exe and Node's LICENSE are all that is needed from it
    if (archive.endsWith('.zip')) {
      const top = archive.replace(/\.zip$/, '');
      const files = unzipSync(readFileSync(file), { filter: (item) => item.name === `${top}/node.exe` || item.name === `${top}/LICENSE` });
      for (const name of ['node.exe', 'LICENSE']) if (!files[`${top}/${name}`]) fail(`${archive} holds no ${name}`);
      mkdirSync(dir, { recursive: true });
      for (const name of ['node.exe', 'LICENSE']) writeFileSync(join(dir, name), files[`${top}/${name}`]);
    } else execFileSync('tar', ['-xf', file, '-C', CACHE]);
  }
  return exe;
}

const archiveOf = (dir) => {
  const entries = {};
  const add = (folder, prefix) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) {
        add(path, `${prefix}${name}/`);
        continue;
      }
      const executable = (statSync(path).mode & 0o111) !== 0;
      entries[`${prefix}${name}`] = [readFileSync(path), { level: 9, os: 3, attrs: (executable ? 0o755 : 0o644) << 16 }];
    }
  };
  add(dir, `vexplor-edge-${version}/`);
  return zipSync(entries);
};

const linux = !process.argv.includes('--no-linux');
const windows = process.argv.includes('--windows');
if (linux && process.platform === 'win32') fail('Linux packages are not built on Windows (no executable bit) — use --windows --no-linux');
if (!linux && !windows) fail('nothing to build — --no-linux needs --windows');

rmSync(join(OUT, 'build'), { recursive: true, force: true });
mkdirSync(join(OUT, 'build'), { recursive: true });
mkdirSync(CACHE, { recursive: true });
const bundled = join(OUT, 'build/vexplor-edge.cjs');
const packages = await bundle(bundled);

const sumsFile = await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, join(CACHE, `SHASUMS256-${NODE_VERSION}.txt`));
const sums = new Map(readFileSync(sumsFile, 'utf8').trim().split('\n').map((line) => line.split(/\s+/).reverse()));
// Node's download names: linux-x64, darwin-arm64, win-x64
const hostPlatform = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const hostNode = await nodeBinary(hostPlatform, sums);

// The SEA blob is made by the very Node version that runs it
const blob = join(OUT, 'build/sea-prep.blob');
writeFileSync(join(OUT, 'build/sea-config.json'), JSON.stringify({ main: bundled, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
execFileSync(hostNode, ['--experimental-sea-config', join(OUT, 'build/sea-config.json')], { stdio: 'ignore' });

const winsw = await download(WINSW.url, join(CACHE, 'WinSW-x64-2.12.0.exe'));
if (sha256(winsw) !== WINSW.sha256) fail('WinSW-x64.exe does not match the pinned hash');
const nodeEntry = { name: 'node', version: NODE_VERSION.slice(1), license: 'MIT' };
const winswEntry = { name: 'winsw', version: '2.12.0', license: 'MIT' };
const results = [];

const platforms = [...(linux ? ['linux-x64', ...(process.argv.includes('--arm64') ? ['linux-arm64'] : [])] : []), ...(windows ? ['win-x64'] : [])];
for (const platform of platforms) {
  // The folder already carries its final name — no tar renaming flags (GNU and BSD tar differ)
  const stage = join(OUT, 'build', platform, `vexplor-edge-${version}`);
  mkdirSync(stage, { recursive: true });
  const exe = join(stage, platform === 'win-x64' ? 'vexplor-edge.exe' : 'vexplor-edge');
  const node = await nodeBinary(platform, sums);
  copyFileSync(node, exe);
  chmodSync(exe, 0o755);
  // postject's own script through this Node — node_modules/.bin/postject is a .cmd on Windows, which execFile cannot run
  execFileSync(process.execPath, [join(ROOT, 'node_modules/postject/dist/cli.js'), exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE, ...(platform === 'win-x64' ? ['--overwrite'] : [])], { stdio: 'ignore' });
  const install = join(ROOT, 'install');
  const extra = platform === 'win-x64' ? [nodeEntry, winswEntry] : [nodeEntry];
  if (platform === 'win-x64') {
    copyFileSync(winsw, join(stage, 'vexplor-edge-service.exe'));
    copyFileSync(join(install, 'vexplor-edge-service.xml'), join(stage, 'vexplor-edge-service.xml'));
    copyFileSync(join(install, 'install.ps1'), join(stage, 'install.ps1'));
  } else {
    copyFileSync(join(install, 'install.sh'), join(stage, 'install.sh'));
    chmodSync(join(stage, 'install.sh'), 0o755);
    copyFileSync(join(install, 'vexplor-edge.service'), join(stage, 'vexplor-edge.service'));
  }
  writeFileSync(join(stage, 'edge.example.json'), `${JSON.stringify({ server: 'https://aas.example.com', stateDir: platform === 'win-x64' ? 'C:/ProgramData/VEXPLOR Edge/state' : '/var/lib/vexplor-edge', proxy: 'http://proxy.plant.local:3128' }, null, 2)}\n`);
  copyFileSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));
  copyFileSync(join(ROOT, 'NOTICE'), join(stage, 'NOTICE'));
  // The license texts of the binaries the package carries (MIT asks for the notice itself, not only its name)
  mkdirSync(join(stage, 'licenses'), { recursive: true });
  copyFileSync(join(dirname(platform === 'win-x64' ? node : dirname(node)), 'LICENSE'), join(stage, 'licenses', 'node-LICENSE.txt'));
  if (platform === 'win-x64') copyFileSync(join(install, 'licenses', 'WinSW-LICENSE.txt'), join(stage, 'licenses', 'WinSW-LICENSE.txt'));
  writeFileSync(join(stage, 'THIRD-PARTY-NOTICES.txt'), notices(packages, extra));
  writeFileSync(join(stage, 'sbom.cdx.json'), sbom(packages, extra));
  const name = `vexplor-edge-${version}-${platform}.${platform === 'win-x64' ? 'zip' : 'tar.gz'}`;
  if (platform === 'win-x64') writeFileSync(join(OUT, name), archiveOf(stage));
  else execFileSync('tar', ['--no-xattrs', '-czf', join(OUT, name), '-C', join(OUT, 'build', platform), `vexplor-edge-${version}`], { stdio: 'ignore', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  results.push(name);
}

// The one-line downloaders, pinned to this version — `releases/latest/download/get.sh` (get.ps1) always fetches the newest
for (const script of [...(linux ? ['get.sh'] : []), ...(windows ? ['get.ps1'] : [])]) {
  const text = readFileSync(join(ROOT, 'scripts', script), 'utf8');
  if (!text.includes('__EDGE_VERSION__')) fail(`scripts/${script} has no __EDGE_VERSION__ placeholder`);
  writeFileSync(join(OUT, script), text.replace('__EDGE_VERSION__', version), { mode: 0o755 });
  results.push(script);
}

writeFileSync(join(OUT, 'SHA256SUMS'), results.map((name) => `${sha256(join(OUT, name))}  ${name}`).join('\n') + '\n');
process.stdout.write(`[OK] ${results.join(', ')} — ${packages.length} bundled packages, Node ${NODE_VERSION}\n`);
