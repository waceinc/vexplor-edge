/**
 * MQTT login end to end against a real AAS Studio server (2.8.0 + edge 1.1.0): the AID says a login is needed, the read
 * list names the broker's address as `credentialRef` and carries no password, and the edge logs in with the pair from
 * its credentials file. Before, the only way was `mqtt://user:password@host` — the password then sat in the AAS and in
 * every read list.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { createHttpServer } from '@aas/api';
import { MqttTestBroker } from '@aas/fieldbus';
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

describe('remote collector — MQTT broker that wants a login', () => {
  it('reads with the pair from credentials.json; the read list names it and carries no password', async () => {
    const broker = new MqttTestBroker({ username: 'edge', password: 'line1-secret' });
    const brokerPort = await broker.listen();
    broker.publish('plant/press1/temp', '61.2', true);
    const endpoint = `mqtt://127.0.0.1:${brokerPort}`;

    const store = new InMemoryStore();
    const pkg = readAasx(golden);
    pkg.environment.submodels!.push(
      buildAidSubmodel({ assetName: 'Press01', iriBase: 'https://example.com/ids', endpoint, security: { login: true }, tags: [{ name: 'Temp', href: 'plant/press1/temp', type: 'float' }] }) as never,
    );
    const record = await store.importPackage({ name: 'press-01.aasx', package: pkg });
    const server = createHttpServer({ store });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const call = async (method: string, path: string, body?: unknown): Promise<unknown> =>
      (await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })).json();
    const { code } = (await call('POST', '/edge/registration-codes')) as { code: string };
    const config = parseEdgeConfig(JSON.stringify({ server: `http://127.0.0.1:${port}`, stateDir: mkdtempSync(join(tmpdir(), 'edge-mqtt-login-')), flushIntervalMs: 150 }), join(tmpdir(), 'edge.json'));
    const agent = new EdgeAgent({ config, credentials: new Map([[endpoint, { userName: 'edge', password: 'line1-secret' }]]), log: () => undefined });
    try {
      const { deviceId } = await agent.register(code);
      const preview = (await call('GET', `/edge/devices/${deviceId}/read-list-preview`)) as { revision: string; interfaces: { interfaceId: string; security: unknown }[] };
      expect(preview.interfaces[0]!.security).toEqual({ mode: 'None', credentialRef: endpoint });
      expect(JSON.stringify(preview)).not.toContain('line1-secret');
      await call('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { [preview.interfaces[0]!.interfaceId]: 200 } });
      await agent.start();
      const end = Date.now() + 15_000;
      let values: { valueNumber?: number }[] = [];
      while (Date.now() < end) {
        values = (await store.readValues(record.id)) as never;
        if (values.some((value) => value.valueNumber === 61.2)) break;
        await sleep(100);
      }
      expect(values.some((value) => value.valueNumber === 61.2)).toBe(true);
    } finally {
      await agent.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await broker.close();
    }
  }, 30_000);
});
