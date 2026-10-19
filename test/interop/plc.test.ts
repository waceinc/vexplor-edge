/**
 * S7 and MC (1.2.0) and XGT against a real AAS Studio server and AAS Studio's own test CPUs (its fieldbus test folder):
 * the read list names the interface, the collector reads it with the server's readers, and a CPU that drops the line
 * or stops answering is read again without restarting the collector.
 *
 * Important: the test CPUs follow the published formats only (RFC 1006, ISO 8073, the MELSEC 3E frame, LS ELECTRIC's
 *    XGT FEnet manual) — this is not a check against a real PLC. Read only: the test CPUs answer Read Var, Batch Read and
 *    the XGT read request and nothing else (the XGT CPU counts any other instruction as a violation).
 * Time is compressed: tags are read every 100 ms. Batches go every 1.2 s — under AAS Studio's 60 requests a minute, so a
 *    stage that runs for 20 s is not paused by the rate limit.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { createHttpServer } from '@aas/api';
import { McMockServer } from '@aas-test/mc-server';
import { XgtMockServer } from '@aas-test/xgt-server';
import { S7MockServer } from '@aas-test/s7-server';
import { InMemoryStore } from '@aas/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EdgeAgent, parseEdgeConfig } from '../../src/index.js';
import { aasFixture } from './aas.js';

const golden = new Uint8Array(readFileSync(aasFixture('01-roll-forming-machine.aasx')));
const saved = process.env['EDGE'];
beforeAll(() => {
  process.env['EDGE'] = 'on';
});
afterAll(() => {
  if (saved === undefined) delete process.env['EDGE'];
  else process.env['EDGE'] = saved;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(50);
  }
}

type Stored = { propertyName: string; valueNumber?: number; valueText?: string; error?: string };

/** AAS Studio with one interface, and an edge registered and approved to read it every 100 ms */
async function studioAndEdge(aid: Record<string, unknown>) {
  const store = new InMemoryStore();
  const pkg = readAasx(golden);
  pkg.environment.submodels!.push(aid as never);
  await store.importPackage({ name: 'press-01.aasx', package: pkg });
  const server = createHttpServer({ store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> =>
    (await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })).json();
  const { code } = (await call('POST', '/edge/registration-codes')) as { code: string };
  const config = parseEdgeConfig(JSON.stringify({ server: `http://127.0.0.1:${port}`, stateDir: mkdtempSync(join(tmpdir(), 'edge-plc-')), flushIntervalMs: 1200 }), join(tmpdir(), 'edge.json'));
  const logs: string[] = [];
  const agent = new EdgeAgent({ config, credentials: new Map(), log: (line) => logs.push(line) });
  const { deviceId } = await agent.register(code);
  const preview = (await call('GET', `/edge/devices/${deviceId}/read-list-preview`)) as {
    revision: string;
    interfaces: { interfaceId: string; protocol: string; tags: { tagId: string; propertyName: string; address: string }[] }[];
  };
  await call('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { [preview.interfaces[0]!.interfaceId]: 100 } });
  const link = () => (agent.status()['interfaces'] as { connected: boolean; lastError: string | null }[])[0];
  /** Stored values, newest first */
  const stored = async (): Promise<Stored[]> => {
    const [record] = (await store.listPackages({})).items;
    return (await store.readValues(record!.id, { limit: 100_000 })) as never;
  };
  const latest = async (name: string): Promise<Stored | undefined> => (await stored()).find((value) => value.propertyName === name);
  const stop = async () => {
    await agent.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { agent, logs, link, preview, latest, stop };
}

describe('remote collector — S7, MC and XGT (VEXPLOR extension bindings, read only)', () => {
  it('S7: reads DB, M and STRING values big-endian; a dropped line and a CPU that stops answering are read again', async () => {
    const cpu = new S7MockServer();
    const db10 = Buffer.alloc(32);
    db10.writeInt16BE(-2, 0);
    db10.writeFloatBE(12.5, 4);
    cpu.dbs.set(10, db10);
    const db2 = Buffer.alloc(32);
    db2.writeUInt8(20, 0);
    db2.writeUInt8(5, 1);
    db2.write('HELLO', 2, 'latin1');
    cpu.dbs.set(2, db2);
    cpu.areas.M.writeUInt8(0b0000_1000, 10);
    const port = await cpu.listen();
    const edge = await studioAndEdge(
      buildAidSubmodel({ assetName: 'Press01', iriBase: 'https://example.com/ids', endpoint: `s7://127.0.0.1:${port}?rack=0&slot=1`, tags: [
        { name: 'Count', href: 'DB10.DBW0:INT', type: 'integer' },
        { name: 'Speed', href: 'DB10.DBD4:REAL', type: 'float' },
        { name: 'Running', href: 'M10.3', type: 'boolean' },
        { name: 'Recipe', href: 'DB2.DBB0:STRING[20]', type: 'string' },
      ] }) as never,
    );
    try {
      expect(edge.preview.interfaces[0]).toMatchObject({ protocol: 'S7' });
      await edge.agent.start();
      await until(async () => (await edge.latest('Recipe'))?.valueText === 'HELLO');
      expect(await edge.latest('Count')).toMatchObject({ valueNumber: -2 });
      expect(await edge.latest('Speed')).toMatchObject({ valueNumber: 12.5 });
      expect(await edge.latest('Running')).toMatchObject({ valueText: 'true' });
      expect(cpu.violations).toBe(0);

      // A cable pull or a CPU restart — the next read opens a new connection
      const before = cpu.connections;
      cpu.drop();
      db10.writeInt16BE(7, 0);
      await until(async () => (await edge.latest('Count'))?.valueNumber === 7);
      expect(cpu.connections).toBeGreaterThan(before);

      // A CPU that stops answering — the link reports it, then reads again once it answers
      cpu.silent = true;
      await until(() => edge.link()?.connected === false && edge.link()?.lastError !== null, 20_000);
      cpu.silent = false;
      db10.writeInt16BE(8, 0);
      await until(async () => (await edge.latest('Count'))?.valueNumber === 8, 20_000);
      await until(() => edge.link()?.connected === true && edge.link()?.lastError === null, 5_000);
      expect(cpu.violations).toBe(0);
    } finally {
      await edge.stop();
      await cpu.close();
    }
  }, 60_000);

  it('MC: reads D words little-endian, word bits and M bits; a missing address fails alone; a dropped line is read again', async () => {
    const D = 0xa8;
    const M = 0x90;
    const cpu = new McMockServer(1024);
    const words = Buffer.alloc(4);
    words.writeInt32LE(-100000, 0);
    cpu.setBytes(D, 100, words);
    cpu.memory.get(D)![10] = 0b1000;
    cpu.memory.get(M)![50] = 1;
    const port = await cpu.listen();
    const edge = await studioAndEdge(
      buildAidSubmodel({ assetName: 'Press01', iriBase: 'https://example.com/ids', endpoint: `melsec://127.0.0.1:${port}?series=Q`, tags: [
        { name: 'Count', href: 'D100:DINT', type: 'integer' },
        { name: 'Bit', href: 'D10.3', type: 'boolean' },
        { name: 'Running', href: 'M50', type: 'boolean' },
        { name: 'Beyond', href: 'D5000', type: 'integer' },
      ] }) as never,
    );
    try {
      expect(edge.preview.interfaces[0]).toMatchObject({ protocol: 'MC' });
      await edge.agent.start();
      await until(async () => (await edge.latest('Count'))?.valueNumber === -100000);
      await until(async () => (await edge.latest('Beyond')) !== undefined);
      expect(await edge.latest('Bit')).toMatchObject({ valueText: 'true' });
      expect(await edge.latest('Running')).toMatchObject({ valueText: 'true' });
      expect((await edge.latest('Beyond'))?.error).toMatch(/C056|range/i);

      const before = cpu.connections;
      cpu.drop();
      words.writeInt32LE(42, 0);
      cpu.setBytes(D, 100, words);
      await until(async () => (await edge.latest('Count'))?.valueNumber === 42);
      expect(cpu.connections).toBeGreaterThan(before);
    } finally {
      await edge.stop();
      await cpu.close();
    }
  }, 60_000);

  it('XGT: reads XGK words little-endian, bits and a contact; an address past the end fails alone; a dropped line and a CPU that stops answering are read again', async () => {
    const cpu = new XgtMockServer();
    const d = cpu.memory.get('D')!;
    d.writeInt32LE(-100000, 200);
    d.writeFloatLE(12.5, 204);
    d.writeUInt16LE(0b1000, 20);
    cpu.memory.get('P')![3] = 0b100;
    cpu.contacts.get('T')!.add(10);
    const port = await cpu.listen();
    const edge = await studioAndEdge(
      buildAidSubmodel({ assetName: 'Press01', iriBase: 'https://example.com/ids', endpoint: `xgt://127.0.0.1:${port}?series=XGK`, tags: [
        { name: 'Count', href: 'D100:DINT', type: 'integer' },
        { name: 'Speed', href: 'D102:REAL', type: 'float' },
        { name: 'Bit', href: 'D10.3', type: 'boolean' },
        { name: 'Running', href: 'P0001A', type: 'boolean' },
        { name: 'Timer', href: 'T10:BOOL', type: 'boolean' },
        { name: 'Beyond', href: 'D5000', type: 'integer' },
      ] }) as never,
    );
    try {
      expect(edge.preview.interfaces[0]).toMatchObject({ protocol: 'XGT' });
      await edge.agent.start();
      await until(async () => (await edge.latest('Count'))?.valueNumber === -100000);
      await until(async () => (await edge.latest('Beyond')) !== undefined);
      expect(await edge.latest('Speed')).toMatchObject({ valueNumber: 12.5 });
      expect(await edge.latest('Bit')).toMatchObject({ valueText: 'true' });
      expect(await edge.latest('Running')).toMatchObject({ valueText: 'true' });
      expect(await edge.latest('Timer')).toMatchObject({ valueText: 'true' });
      expect((await edge.latest('Beyond'))?.error).toMatch(/AddressOutOfRange.*0x0004/);
      expect(cpu.cpuInfo).toBe(0xa0);

      const before = cpu.connections;
      cpu.drop();
      d.writeInt32LE(42, 200);
      await until(async () => (await edge.latest('Count'))?.valueNumber === 42);
      expect(cpu.connections).toBeGreaterThan(before);

      cpu.silent = true;
      await until(() => edge.link()?.connected === false && edge.link()?.lastError !== null, 20_000);
      cpu.silent = false;
      d.writeInt32LE(43, 200);
      await until(async () => (await edge.latest('Count'))?.valueNumber === 43, 20_000);
      await until(() => edge.link()?.connected === true && edge.link()?.lastError === null, 5_000);
      expect(cpu.violations).toEqual([]);
    } finally {
      await edge.stop();
      await cpu.close();
    }
  }, 60_000);
});
