/**
 * The packed collector's OPC UA check: reads the server's clock (ns=0;i=2258, on every OPC UA server) through the same
 * reader the collector uses. pack.mjs bundles this file exactly like the collector, runs it from an empty folder and
 * refuses to pack when it fails — a bundled dependency that reads its own files at start-up breaks only there.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpcUaReader } from '@aas/opcua';

// CommonJS output takes no top-level await
async function main(endpoint) {
  const reader = await OpcUaReader.connect({ endpoint, pkiDir: mkdtempSync(join(tmpdir(), 'edge-smoke-pki-')) });
  try {
    const [result] = await reader.read(['ns=0;i=2258']);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result !== undefined && result.value !== undefined && result.value !== null;
  } finally {
    await reader.close();
  }
}

main(process.argv[2]).then(
  (ok) => process.exit(ok ? 0 : 1),
  (error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
