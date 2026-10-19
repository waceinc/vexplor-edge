/**
 * What breaks on a Windows factory PC and not on Linux (1.2.0, Windows package):
 *
 * - Antivirus and the search indexer open files the moment they are written. Renaming or deleting such a file fails for
 *   a short moment with EPERM / EBUSY / EACCES. The queue must ride that out — retry briefly, and never let a failed
 *   clean-up end the flush (a throw there ended the process on Linux before 1.1.0 for a full disk).
 * - Windows PowerShell 5.1 writes UTF-8 with a byte order mark, and older Notepad does too. JSON.parse refuses a BOM, so
 *   an edge.json or credentials.json written there must still load.
 *
 * The file system is the real one, with renameSync and the deletes (unlinkSync, rmSync) made to fail on demand.
 */
import { mkdtempSync, readdirSync, writeFileSync as realWrite } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const locks = vi.hoisted(() => ({ rename: 0, remove: 0, code: 'EPERM' }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const locked = (what: string): Error => Object.assign(new Error(`${locks.code}: operation not permitted, ${what}`), { code: locks.code });
  const renameSync = ((...args: Parameters<typeof real.renameSync>) => {
    if (locks.rename > 0) {
      locks.rename -= 1;
      throw locked('rename');
    }
    return real.renameSync(...args);
  }) as typeof real.renameSync;
  const unlinkSync = ((...args: Parameters<typeof real.unlinkSync>) => {
    if (locks.remove > 0) {
      locks.remove -= 1;
      throw locked('unlink');
    }
    return real.unlinkSync(...args);
  }) as typeof real.unlinkSync;
  const rmSync = ((...args: Parameters<typeof real.rmSync>) => {
    if (locks.remove > 0) {
      locks.remove -= 1;
      throw locked('rm');
    }
    return real.rmSync(...args);
  }) as typeof real.rmSync;
  return { ...real, default: { ...real, renameSync, unlinkSync, rmSync }, renameSync, unlinkSync, rmSync };
});

import { loadCredentials, loadEdgeConfig, parseEdgeConfig } from '../src/config.js';
import { loadOrCreateIdentity, saveIdentity } from '../src/identity.js';
import { DiskQueue, type Batch } from '../src/queue.js';

beforeEach(() => {
  locks.rename = 0;
  locks.remove = 0;
  locks.code = 'EPERM';
});

const batch = (seq: number): Batch => ({
  schema: 'vexplor.edge.batch/1',
  bootId: 'b',
  seq,
  readListRevision: 'r',
  createdAt: new Date(Date.UTC(2026, 9, 20, 0, 0, seq)).toISOString(),
  samples: [{ tagId: 't', observedAt: '2026-10-20T00:00:00.000Z', receivedAt: '2026-10-20T00:00:00.000Z', value: seq }],
});

const queueDir = () => mkdtempSync(join(tmpdir(), 'edge-win-'));

describe('a file held open for a moment (antivirus, indexer)', () => {
  it('writes the batch to disk once the rename goes through on a retry', () => {
    const dir = queueDir();
    const queue = new DiskQueue(dir, 100);
    locks.rename = 2;
    queue.add(batch(1));
    expect(queue.inMemory).toBe(0);
    expect(readdirSync(join(dir, 'queue'))).toEqual([expect.stringMatching(/_0000000001\.json$/)]);
  });

  for (const code of ['EBUSY', 'EACCES']) {
    it(`retries ${code} like EPERM`, () => {
      const queue = new DiskQueue(queueDir(), 100);
      locks.code = code;
      locks.rename = 1;
      queue.add(batch(1));
      expect(queue.inMemory).toBe(0);
    });
  }

  it('keeps the batch in memory — and does not throw — when the rename and the clean-up both keep failing', () => {
    const queue = new DiskQueue(queueDir(), 100, 30, Date.now, { log: () => undefined });
    locks.rename = 1000;
    locks.remove = 1000;
    expect(() => queue.add(batch(1))).not.toThrow();
    expect(queue.inMemory).toBe(1);
    expect(queue.files()).toHaveLength(1);
  });

  it('a sent batch whose file is held is not sent again, and is deleted once the file is free', () => {
    const dir = queueDir();
    const queue = new DiskQueue(dir, 100);
    queue.add(batch(1));
    queue.add(batch(2));
    const [first] = queue.files();
    locks.remove = 1000;
    expect(() => queue.done(first!)).not.toThrow();
    expect(queue.files()).toHaveLength(1);
    expect(queue.size).toBe(1);
    locks.remove = 0;
    queue.files();
    expect(readdirSync(join(dir, 'queue'))).toHaveLength(1);
  });

  it('a refused batch whose file is held moves to refused/ on a retry', () => {
    const dir = queueDir();
    const queue = new DiskQueue(dir, 100);
    queue.add(batch(1));
    const [name] = queue.files();
    locks.rename = 2;
    queue.refuse(name!);
    expect(readdirSync(join(dir, 'refused'))).toEqual([name]);
  });

  it('a refused batch whose file stays held is kept in refused/ and not offered again', () => {
    const dir = queueDir();
    const queue = new DiskQueue(dir, 100);
    queue.add(batch(1));
    const [name] = queue.files();
    locks.rename = 1000;
    locks.remove = 1000;
    expect(() => queue.refuse(name!)).not.toThrow();
    expect(readdirSync(join(dir, 'refused'))).toEqual([name]);
    expect(queue.files()).toEqual([]);
  });

  it('dropping the oldest batches beyond the bound does not throw while a file is held', () => {
    const queue = new DiskQueue(queueDir(), 1);
    queue.add(batch(1));
    locks.remove = 1000;
    expect(() => queue.add(batch(2))).not.toThrow();
  });

  it('saving the identity goes through a held identity.json on a retry', () => {
    const dir = queueDir();
    const identity = loadOrCreateIdentity(dir);
    locks.rename = 2;
    saveIdentity(dir, { ...identity, deviceId: 'dev_1' });
    expect(loadOrCreateIdentity(dir).deviceId).toBe('dev_1');
  });
});

describe('UTF-8 with a byte order mark (Windows PowerShell 5.1, Notepad)', () => {
  it('reads edge.json written with a BOM', () => {
    const dir = queueDir();
    const file = join(dir, 'edge.json');
    realWrite(file, `\uFEFF${JSON.stringify({ server: 'https://aas.example.com', stateDir: 'C:\\ProgramData\\VEXPLOR Edge\\state' })}`);
    expect(loadEdgeConfig(file).server).toBe('https://aas.example.com');
    expect(parseEdgeConfig(`\uFEFF{"server":"https://aas.example.com","stateDir":"state"}`, file).server).toBe('https://aas.example.com');
  });

  it('reads credentials.json written with a BOM', () => {
    const file = join(queueDir(), 'credentials.json');
    realWrite(file, `\uFEFF${JSON.stringify({ 'opc.tcp://10.0.0.5:4840': { userName: 'u', password: 'p' } })}`);
    expect(loadCredentials(file).get('opc.tcp://10.0.0.5:4840')?.userName).toBe('u');
  });
});
