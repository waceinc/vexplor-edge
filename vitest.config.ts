import { defineConfig } from 'vitest/config';

/** Unit tests — no server needed. The interop tests against a real AAS Studio server: vitest.interop.config.ts */
export default defineConfig({
  test: { include: ['test/*.test.ts'], environment: 'node' },
});
