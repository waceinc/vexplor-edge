/**
 * The collector runs the same equipment-reading stack AAS Studio is tested with. A newer node-opcua resolved here
 * (2.187.9, 2026-10-18) bundled a helper that looks for a package.json at start-up — inside the single-file package
 * there is none, so every OPC UA reader failed on the factory PC while the source-level tests passed. package.json
 * pins node-opcua through `overrides`; this test fails when any node-opcua package differs from AAS Studio's install.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { AAS_DIR } from './aas.js';

const OURS = fileURLToPath(new URL('../../node_modules', import.meta.url));
const versionIn = (modules: string, name: string): string | undefined => {
  try {
    return (JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return undefined;
  }
};

describe('equipment-reading dependencies match AAS Studio', () => {
  it('every node-opcua package has the version AAS Studio is tested with', () => {
    const names = readdirSync(OURS).filter((name) => name.startsWith('node-opcua'));
    expect(names.length).toBeGreaterThan(10);
    const differ = names
      .map((name) => ({ name, ours: versionIn(OURS, name), theirs: versionIn(join(AAS_DIR, 'node_modules'), name) }))
      .filter((entry) => entry.ours !== entry.theirs);
    expect(differ).toEqual([]);
  });
});
