/**
 * 1.1.0 status fields against a real AAS Studio server: a server that does not know `status.host`, `status.server` or
 * the new per-interface fields still takes every batch (contract rule 6 — fields are only added, unknown ones ignored),
 * and keeps the status as the device's last status for its screen. The new batch schema is checked with the server's own
 * validator, so the schema the server will copy accepts what the edge sends.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { createHttpServer } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { startTestServer, type TestServer } from '@aas-test/opcua-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EdgeAgent, parseEdgeConfig } from '../../src/index.js';
import { AAS_DIR, aasFixture } from './aas.js';

let opcua: TestServer;
const saved = process.env['EDGE'];

beforeAll(async () => {
  process.env['EDGE'] = 'on';
  try {
    opcua = await startTestServer(14950);
  } catch {
    opcua = await startTestServer(14951);
  }
}, 60_000);

afterAll(async () => {
  await opcua?.stop();
  if (saved === undefined) delete process.env['EDGE'];
  else process.env['EDGE'] = saved;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(port: number, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return response.json();
}

describe('1.1.0 status — hardware and line state', () => {
  it('a server that does not know the new fields takes every batch and keeps the status', async () => {
    const store = new InMemoryStore();
    const pkg = readAasx(new Uint8Array(readFileSync(aasFixture('01-roll-forming-machine.aasx'))));
    pkg.environment.submodels!.push(
      buildAidSubmodel({
        assetName: 'RollFormingMachine',
        iriBase: 'https://www.smart-factory.kr/ids',
        endpoint: opcua.endpoint,
        tags: [{ name: 'MotorSpeed', href: 'ns=1;s=Machine.MotorSpeed', type: 'float' }],
      }) as never,
    );
    await store.importPackage({ name: 'line1.aasx', package: pkg });
    const server: Server = createHttpServer({ store });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const { code } = (await call(port, 'POST', '/edge/registration-codes')) as { code: string };
    const config = parseEdgeConfig(
      JSON.stringify({ server: `http://127.0.0.1:${port}`, stateDir: mkdtempSync(join(tmpdir(), 'edge-health-')), flushIntervalMs: 150 }),
      join(tmpdir(), 'edge.json'),
    );
    const agent = new EdgeAgent({ config, credentials: new Map() });
    try {
      const { deviceId } = await agent.register(code);
      const preview = (await call(port, 'GET', `/edge/devices/${deviceId}/read-list-preview`)) as { revision: string; interfaces: { interfaceId: string }[] };
      await call(port, 'POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { [preview.interfaces[0]!.interfaceId]: 100 } });
      await agent.start();
      type Device = { deviceId: string; lastStatus: Record<string, unknown> | null };
      let last: Record<string, unknown> | null = null;
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        const { items } = (await call(port, 'GET', '/edge/devices')) as { items: Device[] };
        last = items.find((item) => item.deviceId === deviceId)?.lastStatus ?? null;
        const server = last?.['server'] as { lastSendOkAt?: string | null } | undefined;
        const first = (last?.['interfaces'] as Record<string, unknown>[] | undefined)?.[0];
        if (agent.sender.stats.sent >= 3 && server?.lastSendOkAt && first?.['responseMs'] !== undefined) break;
        await sleep(100);
      }
      // Every batch taken — none refused as SchemaMismatch, every sample stored
      expect(agent.sender.stats.sent).toBeGreaterThan(2);
      expect(agent.sender.stats.refused).toBe(0);
      expect(agent.sender.stats.rejectedSamples).toBe(0);
      // The server kept what the edge said, as it said it
      const host = last?.['host'] as Record<string, number>;
      const line = last?.['server'] as Record<string, unknown>;
      const [iface] = last?.['interfaces'] as Record<string, unknown>[];
      expect(host['diskFreeBytes']).toBeGreaterThan(0);
      expect(host['processUptimeSeconds']).toBeGreaterThanOrEqual(0);
      // Same machine, so the offset worked out from the server's Date header is within a second of zero
      expect(Math.abs(host['clockOffsetMs']!)).toBeLessThanOrEqual(1000);
      expect(line).toMatchObject({ sendFailuresSinceOk: 0, lastSendError: null });
      expect(typeof line['lastSendOkAt']).toBe('string');
      expect(line['roundTripMs']).toBeGreaterThanOrEqual(0);
      expect(iface).toMatchObject({ connected: true, readOkRatio: 1, reconnects: 0, lastDisconnectAt: null });
      expect(iface!['responseMs']).toBeGreaterThanOrEqual(0);

      // The schema of this repository (docs/schemas/batch.schema.json) with the server's own validator
      const { checkSchema } = (await import(join(AAS_DIR, 'apps/api/src/integration/schema-check.ts'))) as {
        checkSchema: (schema: unknown, value: unknown) => { path: string; message: string }[];
      };
      const schema = JSON.parse(readFileSync(new URL('../../docs/schemas/batch.schema.json', import.meta.url), 'utf8')) as unknown;
      const batch = { schema: 'vexplor.edge.batch/1', bootId: agent.bootId, seq: 1, readListRevision: '1', createdAt: new Date().toISOString(), samples: [], status: agent.status() };
      expect(checkSchema(schema, batch)).toEqual([]);
      const example = JSON.parse(readFileSync(new URL('../../docs/examples/batch.json', import.meta.url), 'utf8')) as unknown;
      expect(checkSchema(schema, example)).toEqual([]);
      // and the schema really checks the new fields: a wrong type is caught
      const wrong = { ...batch, status: { ...batch.status, host: { diskFreeBytes: 'full' } } };
      expect(checkSchema(schema, wrong).map((error) => error.path)).toEqual(['/status/host/diskFreeBytes']);
    } finally {
      await agent.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
