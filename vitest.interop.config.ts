import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Interop tests: the collector against a real VEXPLOR AAS Studio server, from a checkout of waceinc/vexplor-aas
 * (AAS_DIR, default ../vexplor-aas — run `npm ci` there first). The @aas packages come from that checkout's sources,
 * so the server, the OPC UA test server and the readers are the very code a release ships.
 */
const AAS = resolve(process.env['AAS_DIR'] ?? '../vexplor-aas');
const at = (path: string): string => resolve(AAS, path);

export default defineConfig({
  resolve: {
    alias: {
      '@aas/core': at('packages/aas-core/src/index.ts'),
      '@aas/aasx': at('packages/aasx/src/index.ts'),
      '@aas/linter': at('packages/linter/src/index.ts'),
      '@aas/store': at('packages/store/src/index.ts'),
      '@aas/collector': at('packages/collector/src/index.ts'),
      '@aas/opcua': at('packages/opcua/src/index.ts'),
      '@aas/fieldbus': at('packages/fieldbus/src/index.ts'),
      '@aas/api': at('apps/api/src/index.ts'),
      '@aas-test/opcua-server': at('packages/opcua/test/server.ts'),
      '@aas-test/s7-server': at('packages/fieldbus/test/s7-mock-server.ts'),
      '@aas-test/mc-server': at('packages/fieldbus/test/mc-mock-server.ts'),
      '@aas-test/xgt-server': at('packages/fieldbus/test/xgt-mock-server.ts'),
    },
  },
  server: { fs: { allow: [AAS, '.'] } },
  test: { include: ['test/interop/*.test.ts'], environment: 'node', testTimeout: 120_000 },
});
