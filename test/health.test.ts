/**
 * Hardware and line state in the batch status (1.1.0): the PC (`status.host`), the line to the server (`status.server`)
 * and each interface's equipment (`responseMs`, `readOkRatio`, `reconnects`, `lastDisconnectAt`).
 *
 * The PC is a fake probe, time is faked and the equipment is a fake reader that answers after 40 ms — every number below
 * is worked out by hand from those.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProtocolReader, ReadResult } from '@aas/collector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/readers.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/readers.js')>()), openReader: vi.fn() }));

import { EdgeAgent } from '../src/agent.js';
import { parseEdgeConfig } from '../src/config.js';
import { ClockOffset, HOST_SAMPLE_MS, HostMonitor, ServerLink, type HostProbe } from '../src/health.js';
import { EdgeHttp as EdgeHttpClass } from '../src/http.js';
import { DiskQueue, Sender, type Batch, type EdgeHttp } from '../src/index.js';
import { openReader, type ReadListInterface } from '../src/readers.js';

const START = Date.parse('2026-10-18T00:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A PC whose CPU counters, memory and disk the test sets */
function fakeProbe() {
  const state = {
    cpu: { busy: 1000, total: 10_000 } as { busy: number; total: number } | undefined,
    memory: { total: 8 * 2 ** 30, available: 2 * 2 ** 30 } as { total: number; available: number } | undefined,
    disk: { blockSize: 4096, blocks: 1_000_000, available: 80_000 },
    uptime: 86_400.7 as number | undefined,
    process: 120.4,
    diskPaths: [] as string[],
  };
  const probe: HostProbe = {
    cpuTimes: () => state.cpu && { ...state.cpu },
    memory: () => state.memory && { ...state.memory },
    disk: (path) => (state.diskPaths.push(path), { ...state.disk }),
    uptime: () => state.uptime,
    processUptime: () => state.process,
  };
  return { state, probe };
}

describe('status.host — the PC', () => {
  it('works out CPU over the last interval, memory, disk of the state folder and uptimes', () => {
    const { state, probe } = fakeProbe();
    const host = new HostMonitor('/var/lib/vexplor-edge', new ClockOffset(), probe);
    // 30 s later: 600 of 2 000 counter units busy → 30 %
    state.cpu = { busy: 1600, total: 12_000 };
    expect(host.status(START + HOST_SAMPLE_MS)).toEqual({
      cpuPercent: 30,
      memoryUsedPercent: 75,
      diskFreeBytes: 80_000 * 4096,
      diskFreePercent: 8,
      uptimeSeconds: 86_400,
      processUptimeSeconds: 120,
    });
    expect(state.diskPaths).toEqual(['/var/lib/vexplor-edge']);
  });

  it('measures at most every 30 s and repeats the last values in between', () => {
    const { state, probe } = fakeProbe();
    const host = new HostMonitor('/s', new ClockOffset(), probe);
    state.cpu = { busy: 2000, total: 12_000 };
    const first = host.status(START);
    state.disk.available = 10;
    state.cpu = { busy: 4000, total: 14_000 };
    expect(host.status(START + HOST_SAMPLE_MS - 1)).toEqual(first);
    expect(state.diskPaths).toHaveLength(1);
    const next = host.status(START + HOST_SAMPLE_MS);
    expect(next.cpuPercent).toBe(100);
    expect(next.diskFreeBytes).toBe(10 * 4096);
  });

  it('leaves out what the OS cannot tell, never sends 0 or null for it', () => {
    const { state, probe } = fakeProbe();
    state.memory = undefined;
    state.uptime = undefined;
    state.cpu = undefined;
    const status = new HostMonitor('/s', new ClockOffset(), probe).status(START);
    expect(Object.keys(status).sort()).toEqual(['diskFreeBytes', 'diskFreePercent', 'processUptimeSeconds']);
  });

  it('the real probe of this PC gives finite numbers (Node built-ins only)', () => {
    vi.useRealTimers();
    const status = new HostMonitor(tmpdir(), new ClockOffset()).status(Date.now());
    for (const value of Object.values(status)) expect(Number.isFinite(value)).toBe(true);
    expect(status.diskFreeBytes).toBeGreaterThan(0);
    expect(status.processUptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('clock offset from the server Date header', () => {
  it('server 7.3 s ahead: answers of whole seconds narrow it to within half a second', () => {
    const clock = new ClockOffset();
    expect(clock.offsetMs).toBeUndefined();
    const offset = 7300;
    // Requests at different sub-second phases, 80 ms round trip, the server answers half way
    for (const start of [START + 100, START + 31_450, START + 62_900, START + 94_650, START + 125_020]) {
      const serverAt = start + 40 + offset;
      clock.add(start, start + 80, new Date(Math.floor(serverAt / 1000) * 1000).toUTCString());
    }
    expect(Math.abs(clock.offsetMs! - offset)).toBeLessThanOrEqual(500);
  });

  it('starts again when the clock is set and the old ranges no longer overlap', () => {
    const clock = new ClockOffset();
    clock.add(START, START + 50, new Date(START).toUTCString());
    expect(Math.abs(clock.offsetMs!)).toBeLessThanOrEqual(1000);
    // The edge's clock was put back 60 s: the server now looks 60 s ahead
    clock.add(START + 10_000, START + 10_050, new Date(START + 70_000).toUTCString());
    expect(clock.offsetMs! - 60_000).toBeGreaterThanOrEqual(-50);
    expect(clock.offsetMs! - 60_000).toBeLessThanOrEqual(1000);
  });

  it('no Date header, no offset', () => {
    const clock = new ClockOffset();
    clock.add(START, START + 10, undefined);
    clock.add(START, START + 10, 'not a date');
    expect(clock.offsetMs).toBeUndefined();
  });
});

const batch = (seq: number): Batch => ({
  schema: 'vexplor.edge.batch/1',
  bootId: '7f1d2c3e-0a4b-4c5d-8e6f-112233445566',
  seq,
  readListRevision: '1',
  createdAt: new Date(START + seq * 1000).toISOString(),
  samples: [],
});

describe('status.server — the line to the server', () => {
  it('counts failed sends since the last good one, keeps the last error and its time, and resets on success', async () => {
    const queue = new DiskQueue(mkdtempSync(join(tmpdir(), 'edge-health-')), 1000);
    queue.add(batch(1));
    queue.add(batch(2));
    const answers: (Error | number)[] = [new Error('connect ECONNREFUSED'), 503, 200, 200];
    const http = {
      async request() {
        const next = answers.shift()!;
        if (next instanceof Error) throw next;
        return { status: next, headers: {}, body: next === 503 ? { code: 'ServerError' } : { accepted: 0, rejected: [] } };
      },
    } as unknown as EdgeHttp;
    const link = new ServerLink();
    const sender = new Sender(http, queue, () => ({}) as never, () => 0.5, link, () => new Date());
    expect(link.status(queue.oldestCreatedAt())).toEqual({
      lastSendOkAt: null,
      lastSendError: null,
      lastSendErrorAt: null,
      sendFailuresSinceOk: 0,
      oldestQueuedAt: new Date(START + 1000).toISOString(),
    });
    await sender.flush();
    vi.setSystemTime(START + 5000);
    await sender.flush();
    expect(link.status(queue.oldestCreatedAt())).toMatchObject({
      lastSendOkAt: null,
      lastSendError: '503 ServerError',
      lastSendErrorAt: new Date(START + 5000).toISOString(),
      sendFailuresSinceOk: 2,
    });
    vi.setSystemTime(START + 9000);
    await sender.flush();
    expect(link.status(queue.oldestCreatedAt())).toEqual({
      lastSendOkAt: new Date(START + 9000).toISOString(),
      lastSendError: '503 ServerError',
      lastSendErrorAt: new Date(START + 5000).toISOString(),
      sendFailuresSinceOk: 0,
      oldestQueuedAt: null,
    });
  });

  it('a real answer feeds the round trip and the clock: a server whose clock is 20 s ahead', async () => {
    vi.useRealTimers();
    const server = createServer((_request, response) => {
      response.sendDate = false;
      response.writeHead(200, { date: new Date(Date.now() + 20_000).toUTCString(), 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const link = new ServerLink();
      const http = new EdgeHttpClass({
        server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        onAnswer: (sentAt, receivedAt, headers) => link.answered(sentAt, receivedAt, headers['date']),
      });
      const { privateKey } = generateKeyPairSync('ed25519');
      for (let i = 0; i < 3; i += 1) await http.request({ device: 'dev_x', key: privateKey }, 'GET', '/edge/v1/read-list');
      expect(link.status(null).roundTripMs).toBeGreaterThanOrEqual(0);
      expect(Math.abs(link.clock.offsetMs! - 20_000)).toBeLessThanOrEqual(1000);
    } finally {
      server.close();
    }
  });

  it('round trip is the average of the last 10 answers', () => {
    const link = new ServerLink();
    expect(link.status(null).roundTripMs).toBeUndefined();
    for (let i = 0; i < 5; i += 1) link.answered(START, START + 500, undefined);
    for (let i = 0; i < 10; i += 1) link.answered(START, START + 100 + i * 10, undefined);
    expect(link.status(null).roundTripMs).toBe(145);
  });
});

class Plc {
  up = true;
  epoch = 0;
}

function slowReader(plc: Plc): ProtocolReader {
  const epoch = plc.epoch;
  return {
    base: '',
    async read(sources: readonly string[]): Promise<ReadResult[]> {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const alive = plc.up && plc.epoch === epoch;
      return sources.map((source) => (alive ? { source, value: 1, quality: 'Good' } : { source, value: null, error: '연결이 끊겼습니다.' }));
    },
    async close(): Promise<void> {},
  };
}

const iface: ReadListInterface = {
  interfaceId: 'a',
  interfaceName: 'a',
  protocol: 'MODBUS',
  endpoint: 'modbus+tcp://a:502/1',
  security: { mode: 'None' },
  intervalMs: 1000,
  tags: [{ tagId: 'a-t1', propertyName: 'Count', address: '20', fields: {} }],
};

async function agentWith(plc: Plc, probe = fakeProbe().probe) {
  vi.mocked(openReader).mockImplementation(async (target) => {
    if (!plc.up) throw new Error(`${target.endpoint} 접속 실패: connect ECONNREFUSED`);
    return slowReader(plc);
  });
  const stateDir = mkdtempSync(join(tmpdir(), 'edge-health-agent-'));
  const config = parseEdgeConfig(JSON.stringify({ server: 'http://127.0.0.1:1', stateDir, flushIntervalMs: 1000 }), join(tmpdir(), 'edge.json'));
  const agent = new EdgeAgent({ config, credentials: new Map(), hostProbe: probe });
  agent.identity = { ...agent.identity, deviceId: 'dev_test' };
  const list = { revision: 'r1', state: 'approved', pollSeconds: 60, interfaces: [iface] };
  vi.spyOn(agent.http, 'request').mockImplementation(async (_signer, method) => ({ status: 200, headers: {}, body: method === 'GET' ? list : {} }));
  (agent as unknown as { tick: () => Promise<void> }).tick = async () => undefined;
  const equipment = () => (agent.status()['interfaces'] as Record<string, unknown>[])[0]!;
  return { agent, equipment, stateDir };
}

describe('status.interfaces — how the equipment answers', () => {
  it('response time, success ratio, reconnects and when it was lost', async () => {
    const plc = new Plc();
    const { agent, equipment } = await agentWith(plc);
    await agent.start();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(equipment()).toEqual({ interfaceId: 'a', connected: true, lastError: null, responseMs: 40, readOkRatio: 1, reconnects: 0, lastDisconnectAt: null });
    // The PLC goes off: 3 failed reads drop the connection, the openings after it fail too
    plc.up = false;
    const off = Date.now();
    await vi.advanceTimersByTimeAsync(10_000);
    const down = equipment();
    expect(down['connected']).toBe(false);
    expect(Date.parse(down['lastDisconnectAt'] as string)).toBeGreaterThanOrEqual(off);
    expect(down['readOkRatio']).toBeLessThan(1);
    expect(down['reconnects']).toBe(0);
    // Back on as a new process: one reconnect, reads good again
    plc.up = true;
    plc.epoch += 1;
    await vi.advanceTimersByTimeAsync(70_000);
    const back = equipment();
    expect(back).toMatchObject({ connected: true, lastError: null, responseMs: 40, reconnects: 1, lastDisconnectAt: down['lastDisconnectAt'] });
    // 10 good + 3 failed reads + failed openings + good ones since — the last 100 at most
    expect(back['readOkRatio']).toBeGreaterThan(0.8);
    expect(back['readOkRatio']).toBeLessThan(1);
    await agent.stop();
  });

  it('a PLC that is off from the start: ratio 0, lost at the first attempt, no reconnect once it comes on', async () => {
    const plc = new Plc();
    plc.up = false;
    const { agent, equipment } = await agentWith(plc);
    await agent.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(equipment()).toMatchObject({ connected: false, readOkRatio: 0, reconnects: 0, lastDisconnectAt: new Date(START).toISOString() });
    expect(equipment()['responseMs']).toBeUndefined();
    plc.up = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(equipment()).toMatchObject({ connected: true, reconnects: 0 });
    await agent.stop();
  });
});

describe('status carried by a batch', () => {
  it('has host and server next to the 1.0 fields, and stays small', async () => {
    const plc = new Plc();
    const { agent } = await agentWith(plc);
    await agent.start();
    await vi.advanceTimersByTimeAsync(3_000);
    const status = agent.status();
    expect(Object.keys(status)).toEqual(expect.arrayContaining(['startedAt', 'queuedBatches', 'droppedBatches', 'software', 'interfaces', 'host', 'server']));
    expect(status['host']).toMatchObject({ diskFreePercent: 8, memoryUsedPercent: 75 });
    expect(status['server']).toMatchObject({ sendFailuresSinceOk: 0, oldestQueuedAt: null });
    // The requests are replaced in this test, so nothing was timed — left out, not sent as 0
    expect((status['server'] as { roundTripMs?: number }).roundTripMs).toBeUndefined();
    expect(JSON.stringify({ host: status['host'], server: status['server'] }).length).toBeLessThan(400);
    await agent.stop();
  });
});
