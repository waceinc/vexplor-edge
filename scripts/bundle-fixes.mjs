/**
 * Rewrites applied while bundling, for dependencies that read their own package files when they load.
 *
 * Inside the single executable there is no node_modules folder: a module that looks for its package.json at start-up
 * finds nothing and stops the collector. node-opcua 2.187 does this in two places that every `import 'node-opcua'`
 * runs (2026-10-18: the OPC UA readers failed on the factory PC while the source-level tests passed).
 *
 * Each fix names the file, the exact text and what replaces it. When the file is bundled and holds the text, the text
 * must occur exactly once; when a newer release changes the text the fix stops matching, and the OPC UA check in
 * pack.mjs (scripts/opcua-smoke.mjs, run from an empty folder) is what refuses the package.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** @typedef {{ file: string, find: string, replace: (moduleId: string) => string, why: string }} BundleFix */

/** The package.json of the package that holds a bundled file */
function manifestOf(moduleId) {
  let dir = dirname(moduleId);
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (typeof manifest.name === 'string') return manifest;
    } catch {
      // not here — go up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${moduleId}`);
    dir = parent;
  }
}

/** @type {BundleFix[]} */
export const BUNDLE_FIXES = [
  {
    file: 'node-opcua-server/dist/opcua_server.js',
    find: 'JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"))\n    .version',
    // The version is read at build time from the file the bundle came from — still the real version, never "unknown"
    replace: (moduleId) => JSON.stringify(manifestOf(moduleId).version),
    why: 'the server reads its own version from ../package.json when it loads',
  },
  {
    file: 'node-opcua-address-space/distHelpers/get_address_space_fixture.js',
    find: 'const packageRoot = findPackageRoot(here);',
    // Test fixtures only; the collector never loads one. The lookup throws when nothing above holds a package.json
    replace: () => 'const packageRoot = here;',
    why: 'a test helper looks for the package root when it loads and throws when there is none',
  },
];

const normalize = (id) => id.replaceAll('\\', '/');

/** rolldown plugin applying BUNDLE_FIXES; `applied` lists the fixes that matched in this build */
export function bundleFixes(fixes = BUNDLE_FIXES) {
  const applied = [];
  return {
    applied,
    plugin: {
      name: 'vexplor-edge-bundle-fixes',
      transform(code, id) {
        const path = normalize(id);
        const fix = fixes.find((entry) => path.endsWith(`/node_modules/${entry.file}`));
        if (!fix) return null;
        // CRLF checkouts (Windows) would hide the text
        const text = code.replaceAll('\r\n', '\n');
        const count = text.split(fix.find).length - 1;
        if (count === 0) return null;
        if (count !== 1) throw new Error(`${fix.file}: the text to rewrite occurs ${count} times, expected 1`);
        applied.push(fix.file);
        // A function, so a `$` in the replacement is not read as a pattern
        return { code: text.replace(fix.find, () => fix.replace(id)), map: null };
      },
    },
  };
}
