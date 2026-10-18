/**
 * Reconnecting to equipment against a real AAS Studio server and AAS Studio's own Modbus test device and MQTT test
 * broker (1.0.0 defect, 2026-10-18): a device restarted while being read, and a broker that was off when the read list
 * arrived, are read again without restarting the collector — and the status says when a link is down.
 *
 * Time is compressed: tags are read every 100 ms, so three failed reads take 0.3 s and the first retry comes after 1 s.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { createHttpServer } from '@aas/api';
import { ModbusTestServer, MqttTestBroker } from '@aas/fieldbus';
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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

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
  const config = parseEdgeConfig(JSON.stringify({ server: `http://127.0.0.1:${port}`, stateDir: mkdtempSync(join(tmpdir(), 'edge-reconnect-')), flushIntervalMs: 150 }), join(tmpdir(), 'edge.json'));
  const logs: string[] = [];
  const agent = new EdgeAgent({ config, credentials: new Map(), log: (line) => logs.push(line) });
  const { deviceId } = await agent.register(code);
  const preview = (await call('GET', `/edge/devices/${deviceId}/read-list-preview`)) as { revision: string; interfaces: { interfaceId: string }[] };
  await call('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { [preview.interfaces[0]!.interfaceId]: 100 } });
  const link = () => (agent.status()['interfaces'] as { connected: boolean; lastError: string | null }[])[0];
  /** Stored values of the one tag, newest first */
  const stored = async (): Promise<{ valueNumber?: number; receivedAt: string }[]> => {
    const [record] = (await store.listPackages({})).items;
    return (await store.readValues(record!.id, { limit: 100_000 })) as never;
  };
  const stop = async () => {
    await agent.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { agent, logs, link, stored, stop };
}

describe('remote collector — equipment that goes away and comes back', () => {
  it('Modbus TCP: a device restarted while being read is read again, and the status shows the gap', async () => {
    let device = new ModbusTestServer();
    const port = await device.listen(0);
    device.tables.HoldingRegister.set(20, 7);
    const edge = await studioAndEdge(
      buildAidSubmodel({ assetName: 'Press01', iriBase: 'https://example.com/ids', endpoint: `modbus+tcp://127.0.0.1:${port}/1`, tags: [
        { name: 'ProductionCount', href: '20', type: 'integer', form: { modv_entity: 'HoldingRegister', modv_type: 'xsd:unsignedShort' } },
      ] }) as never,
    );
    try {
      await edge.agent.start();
      await until(async () => (await edge.stored()).some((value) => value.valueNumber === 7));
      await device.close();
      await until(() => edge.link()?.connected === false, 5_000);
      expect(edge.link()?.lastError).toBeTruthy();
      device = new ModbusTestServer();
      await device.listen(port);
      device.tables.HoldingRegister.set(20, 8);
      await until(async () => (await edge.stored())[0]?.valueNumber === 8, 15_000);
      expect(edge.link()).toMatchObject({ connected: true, lastError: null });
      expect(edge.logs.some((line) => /reconnecting in/.test(line))).toBe(true);
      expect(edge.logs.some((line) => /connected again/.test(line))).toBe(true);
    } finally {
      await edge.stop();
      await device.close();
    }
  }, 30_000);

  it('MQTT: a broker that was off when the read list arrived is read once it is on', async () => {
    const port = await freePort();
    const edge = await studioAndEdge(
      buildAidSubmodel({ assetName: 'Press01', iriBase: 'https://example.com/ids', endpoint: `mqtt://127.0.0.1:${port}`, tags: [
        { name: 'Temp', href: 'plant/press1/temp', type: 'float', form: { mqv_controlPacket: 'subscribe' } },
      ] }) as never,
    );
    const broker = new MqttTestBroker();
    try {
      await edge.agent.start();
      await until(() => edge.link()?.connected === false && edge.link()?.lastError !== null, 5_000);
      await broker.listen(port);
      broker.publish('plant/press1/temp', '61.2', true);
      await until(async () => (await edge.stored()).some((value) => value.valueNumber === 61.2), 15_000);
      expect(edge.link()).toMatchObject({ connected: true, lastError: null });
    } finally {
      await edge.stop();
      await broker.close();
    }
  }, 30_000);
});
