/**
 * MQTT login from the factory PC's credentials file (1.1.0). AAS Studio 2.8.0 lists an MQTT broker that wants a login
 * with `credentialRef` = its address and no password; the edge finds the pair in credentials.json, as for OPC UA.
 * Before, credentials were used for OPC UA only, so such a broker refused the connection (code 4).
 */
import { MqttTestBroker } from '@aas/fieldbus';
import { afterEach, describe, expect, it } from 'vitest';
import { openReader, type ReadListInterface } from '../src/readers.js';

const opcua = { pkiDir: 'unused', trustFirstUse: false };

function mqttInterface(endpoint: string, credentialRef?: string): ReadListInterface {
  return {
    interfaceId: 'pkg_1:InterfaceTemplateForMQTT',
    interfaceName: 'InterfaceTemplateForMQTT',
    protocol: 'MQTT',
    endpoint,
    security: { mode: 'None', ...(credentialRef ? { credentialRef } : {}) },
    intervalMs: 1000,
    tags: [{ tagId: 'tag_1', propertyName: 'Temperature', address: 'plant/m1/temp', type: 'float', fields: { mqv_controlPacket: 'subscribe' } }],
  };
}

describe('MQTT login', () => {
  let broker: MqttTestBroker | undefined;
  afterEach(async () => {
    await broker?.close();
  });

  it('logs in with the pair the credentials file holds for that address', async () => {
    broker = new MqttTestBroker({ username: 'edge', password: 'p@ss:/word' });
    const port = await broker.listen();
    broker.publish('plant/m1/temp', '36.6', true);
    const endpoint = `mqtt://127.0.0.1:${port}`;
    const credentials = new Map([[endpoint, { userName: 'edge', password: 'p@ss:/word' }]]);
    const reader = await openReader(mqttInterface(endpoint, endpoint), { credentials, opcua });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await reader.read(['plant/m1/temp']))[0]!.value).toBe(36.6);
      // The address the reader reports is the listed one — the password lives only in the connection
      expect(reader.base).not.toContain('p@ss');
    } finally {
      await reader.close();
    }
  });

  it('says which credential is missing instead of trying anonymously', async () => {
    await expect(openReader(mqttInterface('mqtt://127.0.0.1:1', 'mqtt://127.0.0.1:1'), { credentials: new Map(), opcua })).rejects.toThrow(/no credential named mqtt:\/\/127\.0\.0\.1:1/);
  });
});
