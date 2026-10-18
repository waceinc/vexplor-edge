/**
 * Reconnecting to equipment (1.0.0 defect, 2026-10-18): a PLC that was off when the read list arrived, or a PLC / broker
 * that restarted while being read, was never read again until the service restarted — and a dead connection kept
 * sending empty values while the status said "connected".
 *
 * Fake readers stand in for the protocol readers: a device can be down (open refused) or restarted (the connection a
 * reader holds is dead, every read returns an error — as the Modbus, OPC UA and MQTT readers do). Time is faked.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProtocolReader, ReadResult } from '@aas/collector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/readers.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/readers.js')>()), openReader: vi.fn() }));

import { EdgeAgent } from '../src/agent.js';
import { parseEdgeConfig } from '../src/config.js';
import { openReader, type ReadListInterface, type Sample } from '../src/readers.js';

class Device {
  up = true;
  epoch = 0;
  value = 1;
  closeThrows = false;
  opens: number[] = [];
  /** Off, then on again as a new process: connections made before are dead */
  restart(): void {
    this.epoch += 1;
  }
}

const iface = (id: string): ReadListInterface => ({
  interfaceId: id,
  interfaceName: id,
  protocol: 'MODBUS',
  endpoint: `modbus+tcp://${id}:502/1`,
  security: { mode: 'None' },
  intervalMs: 1000,
  tags: [{ tagId: `${id}-t1`, propertyName: 'Count', address: '20', fields: {} }],
});

function fakeReader(device: Device): ProtocolReader {
  const epoch = device.epoch;
  return {
    base: '',
    async read(sources: readonly string[]): Promise<ReadResult[]> {
      const alive = device.up && device.epoch === epoch;
      return sources.map((source) => (alive ? { source, value: device.value, quality: 'Good' } : { source, value: null, error: '연결이 끊겼습니다.' }));
    },
    async close(): Promise<void> {
      if (device.closeThrows) throw new Error('close failed');
    },
  };
}

async function agentWith(devices: Map<string, Device>) {
  vi.mocked(openReader).mockImplementation(async (target) => {
    const device = devices.get(target.interfaceId)!;
    device.opens.push(Date.now());
    if (!device.up) throw new Error(`${target.endpoint} 접속 실패: connect ECONNREFUSED`);
    return fakeReader(device);
  });
  const config = parseEdgeConfig(JSON.stringify({ server: 'http://127.0.0.1:1', stateDir: mkdtempSync(join(tmpdir(), 'edge-reconnect-')), flushIntervalMs: 1000 }), join(tmpdir(), 'edge.json'));
  const logs: string[] = [];
  const agent = new EdgeAgent({ config, credentials: new Map(), log: (line) => logs.push(line) });
  agent.identity = { ...agent.identity, deviceId: 'dev_test' };
  const list = { revision: 'r1', state: 'approved', pollSeconds: 60, interfaces: [...devices.keys()].map(iface) };
  vi.spyOn(agent.http, 'request').mockImplementation(async (_signer, method) =>
    method === 'GET' ? { status: list ? 200 : 304, headers: {}, body: list } : { status: 200, headers: {}, body: {} },
  );
  // Batching and sending are not under test: samples stay in the buffer where the test can see them
  (agent as unknown as { tick: () => Promise<void> }).tick = async () => undefined;
  const buffer = (): Sample[] => (agent as unknown as { buffer: Sample[] }).buffer;
  const link = (id: string) => (agent.status()['interfaces'] as { interfaceId: string; connected: boolean; lastError: string | null }[]).find((item) => item.interfaceId === id);
  return { agent, logs, buffer, link };
}

const goodSince = (samples: Sample[], tagId: string, at: number): Sample[] =>
  samples.filter((sample) => sample.tagId === tagId && Date.parse(sample.receivedAt) >= at && sample.error === undefined && sample.value !== null);

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-18T00:00:00.000Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('reconnecting to equipment', () => {
  it('a PLC that was off when the read list arrived is read once it comes on', async () => {
    const plc = new Device();
    plc.up = false;
    const { agent, buffer, link } = await agentWith(new Map([['a', plc]]));
    await agent.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(link('a')).toMatchObject({ connected: false });
    expect(link('a')?.lastError).toMatch(/ECONNREFUSED/);
    plc.up = true;
    const on = Date.now();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(goodSince(buffer(), 'a-t1', on).length).toBeGreaterThan(5);
    expect(link('a')).toEqual({ interfaceId: 'a', connected: true, lastError: null });
    await agent.stop();
  });

  it('a PLC restarted while being read: the dead connection is closed and opened again', async () => {
    const plc = new Device();
    const { agent, buffer, link, logs } = await agentWith(new Map([['a', plc]]));
    await agent.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(goodSince(buffer(), 'a-t1', 0).length).toBeGreaterThan(1);
    plc.up = false;
    await vi.advanceTimersByTimeAsync(5_000);
    // A dead connection is reported, not shown as connected with empty values
    expect(link('a')?.connected).toBe(false);
    expect(link('a')?.lastError).toBeTruthy();
    plc.up = true;
    plc.restart();
    plc.value = 8;
    const on = Date.now();
    await vi.advanceTimersByTimeAsync(30_000);
    const back = goodSince(buffer(), 'a-t1', on);
    expect(back.length).toBeGreaterThan(5);
    expect(back.at(-1)?.value).toBe(8);
    expect(link('a')).toEqual({ interfaceId: 'a', connected: true, lastError: null });
    expect(logs.some((line) => /reconnect/i.test(line))).toBe(true);
    expect(logs.some((line) => /connected again/i.test(line))).toBe(true);
    await agent.stop();
  });

  it('a close that throws does not stop the reconnect', async () => {
    const plc = new Device();
    plc.closeThrows = true;
    const { agent, buffer } = await agentWith(new Map([['a', plc]]));
    await agent.start();
    await vi.advanceTimersByTimeAsync(2_000);
    plc.restart();
    const on = Date.now();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(goodSince(buffer(), 'a-t1', on).length).toBeGreaterThan(5);
    await agent.stop();
  });

  it('backs off exponentially up to 60 s, and logs without flooding', async () => {
    const plc = new Device();
    plc.up = false;
    const { agent, logs } = await agentWith(new Map([['a', plc]]));
    await agent.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const gaps = plc.opens.slice(1).map((at, index) => at - plc.opens[index]!);
    expect(plc.opens.length).toBeGreaterThan(20);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000);
    expect(gaps[0]!).toBeLessThan(2_000);
    expect(gaps.slice(-5).every((gap) => gap >= 30_000)).toBe(true);
    // Thirty minutes of a PLC that stays off: a handful of lines, not one per attempt
    expect(logs.filter((line) => line.startsWith('a:')).length).toBeLessThanOrEqual(12);
    // Once it is reached, the delay starts again from 1 s
    plc.up = true;
    await vi.advanceTimersByTimeAsync(61_000);
    plc.restart();
    const before = plc.opens.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(plc.opens.length).toBeGreaterThan(before);
    await agent.stop();
  });

  it('one interface reconnecting does not hold up another', async () => {
    const down = new Device();
    down.up = false;
    const fine = new Device();
    const { agent, buffer, link } = await agentWith(
      new Map([
        ['a', down],
        ['b', fine],
      ]),
    );
    await agent.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(goodSince(buffer(), 'b-t1', 0).length).toBeGreaterThanOrEqual(18);
    expect(link('b')).toEqual({ interfaceId: 'b', connected: true, lastError: null });
    expect(link('a')?.connected).toBe(false);
    await agent.stop();
  });

  it('OPC UA subscribe: a subscription gone quiet after a server restart is noticed and made again', async () => {
    const plc = new Device();
    const subscribed: number[] = [];
    vi.mocked(openReader).mockImplementation(async () => {
      plc.opens.push(Date.now());
      if (!plc.up) throw new Error('opc.tcp://a 접속 실패: connect ECONNREFUSED');
      const reader = fakeReader(plc);
      return Object.assign(reader, {
        async subscribe(sources: readonly string[], _options: unknown, onChange: (result: ReadResult) => void) {
          subscribed.push(Date.now());
          // The initial report; afterwards the server reports changes only — and nothing at all once it has restarted
          for (const source of sources) onChange({ source, value: plc.value, quality: 'Good' });
          return { close: async () => undefined };
        },
      });
    });
    const config = parseEdgeConfig(
      JSON.stringify({ server: 'http://127.0.0.1:1', stateDir: mkdtempSync(join(tmpdir(), 'edge-reconnect-')), flushIntervalMs: 1000, opcua: { mode: 'subscribe', resendMs: 10_000 } }),
      join(tmpdir(), 'edge.json'),
    );
    const agent = new EdgeAgent({ config, credentials: new Map() });
    agent.identity = { ...agent.identity, deviceId: 'dev_test' };
    const list = { revision: 'r1', state: 'approved', pollSeconds: 60, interfaces: [{ ...iface('a'), protocol: 'OPCUA' as const, intervalMs: 5000 }] };
    vi.spyOn(agent.http, 'request').mockResolvedValue({ status: 200, headers: {}, body: list });
    (agent as unknown as { tick: () => Promise<void> }).tick = async () => undefined;
    const buffer = (agent as unknown as { buffer: Sample[] }).buffer;
    await agent.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(subscribed.length).toBe(1);
    plc.restart();
    plc.value = 8;
    const at = Date.now();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(subscribed.length).toBe(2);
    expect(goodSince(buffer, 'a-t1', at).some((sample) => sample.value === 8)).toBe(true);
    // While the check failed, the old value was not sent again as if it were fresh
    const stale = goodSince(buffer, 'a-t1', at).filter((sample) => sample.value === 1);
    expect(stale.length).toBeLessThanOrEqual(1);
    await agent.stop();
  });

  it('stop closes everything and opens nothing afterwards', async () => {
    const plc = new Device();
    plc.up = false;
    const { agent } = await agentWith(new Map([['a', plc]]));
    await agent.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await agent.stop();
    const opens = plc.opens.length;
    plc.up = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(plc.opens.length).toBe(opens);
  });
});
