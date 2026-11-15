/**
 * The rewrites pack.mjs applies while bundling (scripts/bundle-fixes.mjs). The end-to-end check — the bundled reader
 * reading an OPC UA server from an empty folder — runs inside pack.mjs; these tests hold the rewrite rules themselves.
 */
import { describe, expect, it } from 'vitest';

import { BUNDLE_FIXES, bundleFixes } from '../scripts/bundle-fixes.mjs';

const at = (file: string) => `/build/node_modules/${file}`;
const fixFor = (file: string) => {
  const fix = BUNDLE_FIXES.find((entry) => entry.file === file);
  if (!fix) throw new Error(`no fix for ${file}`);
  return fix;
};

describe('bundle fixes', () => {
  it('replaces the package-root lookup of the address-space test helper', () => {
    const { plugin, applied } = bundleFixes();
    const file = 'node-opcua-address-space/distHelpers/get_address_space_fixture.js';
    const result = plugin.transform(`const here = import.meta.dirname;\n${fixFor(file).find}\n`, at(file));
    expect(result?.code).toContain('const packageRoot = here;');
    expect(result?.code).not.toContain('findPackageRoot(here)');
    expect(applied).toEqual([file]);
  });

  it('accepts the text in a CRLF checkout', () => {
    const { plugin } = bundleFixes();
    const file = 'node-opcua-address-space/distHelpers/get_address_space_fixture.js';
    expect(plugin.transform(`a;\r\n${fixFor(file).find}\r\n`, at(file))).not.toBeNull();
  });

  it('leaves files without the text alone — older releases do not read their files', () => {
    const { plugin, applied } = bundleFixes();
    expect(plugin.transform('const packageVersion = "2.178.0";', at('node-opcua-server/dist/opcua_server.js'))).toBeNull();
    expect(plugin.transform('anything', at('node-opcua-client/dist/index.js'))).toBeNull();
    expect(applied).toEqual([]);
  });

  it('refuses text that occurs more than once', () => {
    const { plugin } = bundleFixes();
    const file = 'node-opcua-address-space/distHelpers/get_address_space_fixture.js';
    const find = fixFor(file).find;
    expect(() => plugin.transform(`${find}\n${find}\n`, at(file))).toThrow(/occurs 2 times/);
  });

  it('writes a literal into the replacement, not a pattern', () => {
    const { plugin } = bundleFixes([{ file: 'x/y.js', find: 'FIND', replace: () => "'$&'", why: 'test' }]);
    expect(plugin.transform('a FIND b', at('x/y.js'))?.code).toBe("a '$&' b");
  });
});
