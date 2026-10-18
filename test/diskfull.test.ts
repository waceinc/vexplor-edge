/**
 * A full disk (1.1.0): writing a batch to the queue fails with ENOSPC. Before 1.1.0 the write threw inside the flush
 * timer, nothing caught it, and Node ends the process on an unhandled rejection — the collector stopped reading.
 *
 * Now the collector keeps reading and sending: a batch it cannot write waits in memory (bounded), goes out from there,
 * is written to disk once there is room again, and one it must drop is counted in `droppedBatches` — never silently.
 * The file system is the real one with `writeFileSync` made to fail while `full` is set.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProtocolReader } from '@aas/collector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ full: false }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const writeFileSync = ((...args: Parameters<typeof real.writeFileSync>) => {
    if (disk.full) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return real.writeFileSync(...args);
  }) as typeof real.writeFileSync;
  return { ...real, default: { ...real, writeFileSync }, writeFileSync };
});
vi.mock('../src/readers.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/readers.js')>()), openReader: vi.fn() }));

import { EdgeAgent } from '../src/agent.js';
import { parseEdgeConfig } from '../src/config.js';
import { DiskQueue, type Batch } from '../src/queue.js';
import { openReader, type ReadListInterface } from '../src/readers.js';

const START = Date.parse('2026-10-18T00:00:00.000Z');

beforeEach(() => {
  disk.full = false;
  vi.useFakeTimers({ now: START });
});
afterEach(() => {
  disk.full = false;
  vi.useRealTimers();
});

const iface: ReadListInterface = {
  interfaceId: 'a',
  interfaceName: 'a',
  protocol: 'MODBUS',
  endpoint: 'modbus+tcp://a:502/1',
  security: { mode: 'None' },
  intervalMs: 500,
  tags: [{ tagId: 'a-t1', propertyName: 'Count', address: '20', fields: {} }],
};

const reader: ProtocolReader = { base: '', read: async (sources) => sources.map((source) => ({ source, value: 1, quality: 'Good' })), close: async () => undefined };

function agentWith(server: { up: boolean }) {
  vi.mocked(openReader).mockResolvedValue(reader);
  const config = parseEdgeConfig(
    JSON.stringify({ server: 'http://127.0.0.1:1', stateDir: mkdtempSync(join(tmpdir(), 'edge-diskfull-')), flushIntervalMs: 1000 }),
    join(tmpdir(), 'edge.json'),
  );
  const logs: string[] = [];
  const agent = new EdgeAgent({ config, credentials: new Map(), log: (line) => logs.push(line) });
  agent.identity = { ...agent.identity, deviceId: 'dev_test' };
  const list = { revision: 'r1', state: 'approved', pollSeconds: 60, interfaces: [iface] };
  const sent: Batch[] = [];
  vi.spyOn(agent.http, 'request').mockImplementation(async (_signer, method, _target, body) => {
    if (method === 'GET') return { status: 200, headers: {}, body: list };
    if (!server.up) throw new Error('connect ECONNREFUSED');
    sent.push(body as Batch);
    return { status: 200, headers: {}, body: { accepted: (body as Batch).samples.length, rejected: [] } };
  });
  return { agent, logs, sent };
}

describe('a full disk', () => {
  it('the collector keeps reading and sending, reports the write error once, and writes again when there is room', async () => {
    const server = { up: true };
    const { agent, logs, sent } = agentWith(server);
    await agent.start();
    await vi.advanceTimersByTimeAsync(3_000);
    disk.full = true;
    const before = { collected: agent.collected, sent: sent.length };
    await vi.advanceTimersByTimeAsync(20_000);
    // Still reading, and the batches that could not be written went out from memory
    expect(agent.collected).toBeGreaterThan(before.collected + 30);
    expect(sent.length).toBeGreaterThan(before.sent + 15);
    const host = agent.status()['host'] as Record<string, unknown>;
    expect(host['queueWriteError']).toMatch(/ENOSPC/);
    expect(Date.parse(host['queueWriteErrorAt'] as string)).toBeGreaterThanOrEqual(START + 3_000);
    expect(logs.filter((line) => /queue/i.test(line) && /ENOSPC/.test(line))).toHaveLength(1);
    // Every sample read reached the server — none dropped
    expect(agent.status()['droppedBatches']).toBe(0);
    disk.full = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logs.filter((line) => /queue/i.test(line) && /again/i.test(line))).toHaveLength(1);
    expect((agent.status()['host'] as Record<string, unknown>)['queuedInMemory']).toBe(0);
    await agent.stop();
    const stored = sent.reduce((sum, batch) => sum + batch.samples.length, 0);
    expect(stored + agent.pending).toBe(agent.collected);
  });

  it('with the server gone too, batches wait in memory and are written to disk once there is room — none lost', async () => {
    const server = { up: false };
    const { agent, sent } = agentWith(server);
    await agent.start();
    disk.full = true;
    await vi.advanceTimersByTimeAsync(130_000);
    const host = agent.status()['host'] as Record<string, number>;
    expect(host['queuedInMemory']).toBeGreaterThan(0);
    expect(agent.queue.size).toBe(host['queuedInMemory']);
    disk.full = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect((agent.status()['host'] as Record<string, number>)['queuedInMemory']).toBe(0);
    server.up = true;
    await vi.advanceTimersByTimeAsync(400_000);
    await agent.stop();
    expect(sent.reduce((sum, batch) => sum + batch.samples.length, 0) + agent.pending).toBe(agent.collected);
    expect(agent.status()['droppedBatches']).toBe(0);
  });
});

const batch = (seq: number): Batch => ({
  schema: 'vexplor.edge.batch/1',
  bootId: '7f1d2c3e-0a4b-4c5d-8e6f-112233445566',
  seq,
  readListRevision: '1',
  createdAt: new Date(START + seq * 1000).toISOString(),
  samples: [{ tagId: 't', observedAt: new Date(START).toISOString(), receivedAt: new Date(START).toISOString(), value: seq }],
});

describe('the queue on a full disk', () => {
  it('holds what it cannot write in memory up to its bound, drops the oldest beyond it and counts them', () => {
    const logs: string[] = [];
    const queue = new DiskQueue(mkdtempSync(join(tmpdir(), 'edge-q-')), 1000, 30, () => START, { log: (line) => logs.push(line), memoryBatches: 3 });
    queue.add(batch(1));
    disk.full = true;
    for (let seq = 2; seq <= 6; seq += 1) queue.add(batch(seq));
    // 1 on disk, 3 in memory (4 · 5 · 6), 2 and 3 dropped
    expect(queue.files().map((name) => queue.read(name).seq)).toEqual([1, 4, 5, 6]);
    expect(queue.inMemory).toBe(3);
    expect(queue.dropped).toBe(2);
    expect(queue.writeError).toMatchObject({ message: expect.stringMatching(/ENOSPC/) });
    expect(logs).toHaveLength(1);
    // Sent from memory like any other
    queue.done(queue.files()[1]!);
    expect(queue.files().map((name) => queue.read(name).seq)).toEqual([1, 5, 6]);
    // Room again: the next add writes the ones in memory first, in order
    disk.full = false;
    queue.add(batch(7));
    expect(queue.inMemory).toBe(0);
    expect(queue.files().map((name) => queue.read(name).seq)).toEqual([1, 5, 6, 7]);
    expect(logs).toHaveLength(2);
  });

  it('also bounds memory by samples', () => {
    const queue = new DiskQueue(mkdtempSync(join(tmpdir(), 'edge-q-')), 1000, 30, () => START, { memorySamples: 2 });
    disk.full = true;
    for (let seq = 1; seq <= 4; seq += 1) queue.add(batch(seq));
    expect(queue.inMemory).toBe(2);
    expect(queue.dropped).toBe(2);
  });
});
