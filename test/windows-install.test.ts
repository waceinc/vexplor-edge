/**
 * The Windows installer scripts (1.2.0), read as text — a Mac or Linux machine cannot run them, so the mistakes that
 * would only show on a factory PC are caught here. CI parses and runs them on a Windows runner (.github/workflows/ci.yml).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const scripts = ['scripts/get.ps1', 'install/install.ps1'];

describe('the Windows installer scripts', () => {
  it('are ASCII — Windows PowerShell 5.1 reads a script without byte order mark in the system code page', () => {
    for (const path of [...scripts, 'install/vexplor-edge-service.xml']) {
      const lines = read(path)
        .split('\n')
        .flatMap((line, at) => ([...line].some((char) => char.charCodeAt(0) > 127) ? [`${path}:${at + 1}`] : []));
      expect(lines).toEqual([]);
    }
  });

  it('get.ps1 is pinned to its release by the placeholder pack.mjs fills, and checks SHA256SUMS before installing', () => {
    const text = read('scripts/get.ps1');
    expect(text).toContain("$Version = '__EDGE_VERSION__'");
    expect(text.indexOf('Get-FileHash -Algorithm SHA256')).toBeGreaterThan(0);
    expect(text.indexOf('Get-FileHash -Algorithm SHA256')).toBeLessThan(text.indexOf('Expand-Archive'));
  });

  it('bypasses the execution policy for the installer file only — never for the session or the machine', () => {
    for (const path of scripts) {
      const text = read(path);
      expect(text).not.toMatch(/Set-ExecutionPolicy/i);
      for (const line of text.split('\n').filter((row) => /-ExecutionPolicy\s+Bypass/i.test(row) && !row.trim().startsWith('#'))) {
        expect(line).toMatch(/-File\b/);
      }
    }
  });

  it('names accounts by SID — the names are translated on non-English Windows', () => {
    const icacls = read('install/install.ps1')
      .split('\n')
      .filter((line) => /\bicacls\b/.test(line) && !line.trim().startsWith('#'));
    expect(icacls.length).toBeGreaterThan(0);
    for (const line of icacls) expect(line).not.toMatch(/(SYSTEM|Administrators|LOCAL SERVICE):/i);
  });

  it('writes edge.json without a byte order mark and calls sc.exe, never the sc alias (Set-Content)', () => {
    const text = read('install/install.ps1');
    const code = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/Set-Content|Out-File/);
    expect(code).toContain('UTF8Encoding $false');
    expect(code).not.toMatch(/(^|[\s{(;])sc\s/m);
  });
});
