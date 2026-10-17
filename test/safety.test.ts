/**
 * STD-009 T10 — the collector's own code: it listens on no port, runs no command, evaluates no code, carries no
 * password, never acts on a command from the server, and only its entry point ends the process. Read from the source,
 * so a change that adds any of these fails here before it ships.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('what the collector never does', () => {
  it('T10 — the edge code listens on no port, runs no command, has no remote stop and no built-in account', () => {
    const dir = fileURLToPath(new URL('../src', import.meta.url));
    const source = readdirSync(dir).map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
    const forbidden: [string, RegExp][] = [
      ['listening server', /\bcreateServer\s*\(|\.listen\s*\(/],
      ['running a command', /child_process|\bexecSync\b|\bexecFile\b|\bspawn\s*\(/],
      ['evaluating code', /\beval\s*\(|new Function\s*\(/],
      ['a built-in password', /password\s*[:=]\s*['"][^'"]+['"]/i],
      ['acting on a command from the server', /['"](shutdown|reboot|uninstall|remote-?stop|kill)['"]/i],
    ];
    const found = source.flatMap(({ file, text }) => forbidden.filter(([, pattern]) => pattern.test(text)).map(([what]) => `${file}: ${what}`));
    expect(found).toEqual([]);
    // Only the entry point ends the process — never an answer from the server
    expect(source.filter(({ file, text }) => file !== 'bin.ts' && /process\.exit/.test(text)).map(({ file }) => file)).toEqual([]);
  });
});
