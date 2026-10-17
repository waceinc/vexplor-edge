/**
 * The contract has one canonical text — this repository's docs/contract.md, docs/schemas and docs/examples. VEXPLOR AAS
 * Studio keeps the copy its server follows (docs/edge-contract.md, docs/edge/). The machine-read parts must be byte for
 * byte the same: every schema, every example and the signing worked example.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { AAS_DIR } from './aas.js';

const HERE = fileURLToPath(new URL('../../docs', import.meta.url));
const worked = (text: string): string => text.slice(text.indexOf('**Worked example**'), text.indexOf('## 3.'));

describe('contract parity with the AAS Studio server copy', () => {
  for (const folder of ['schemas', 'examples']) {
    it(`docs/${folder} equals AAS Studio docs/edge/${folder}`, () => {
      const ours = readdirSync(join(HERE, folder)).sort();
      expect(readdirSync(join(AAS_DIR, 'docs/edge', folder)).sort()).toEqual(ours);
      for (const file of ours) expect(readFileSync(join(AAS_DIR, 'docs/edge', folder, file), 'utf8'), file).toBe(readFileSync(join(HERE, folder, file), 'utf8'));
    });
  }

  it('the signing worked example is the same in both', () => {
    const ours = worked(readFileSync(join(HERE, 'contract.md'), 'utf8'));
    expect(ours.length).toBeGreaterThan(200);
    expect(worked(readFileSync(join(AAS_DIR, 'docs/edge-contract.md'), 'utf8'))).toBe(ours.replaceAll('](examples/', '](edge/examples/').replaceAll('`docs/examples/', '`docs/edge/examples/'));
  });
});
