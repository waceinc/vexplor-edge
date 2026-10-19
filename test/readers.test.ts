/**
 * Which reader a read-list interface gets (1.2.0: S7 and MC, then XGT) — from the installed @aas/fieldbus, as the packaged
 * collector has it.
 *
 * Important: the reader names are checked, not only "something opened" — an S7 interface handed to the Modbus reader
 *    would connect to port 102 and send Modbus frames to a PLC. A protocol this edge does not read keeps failing with the
 *    reason the status reports, which is what an older edge does with S7 and MC (contract §4).
 */
import { describe, expect, it } from 'vitest';
import { openReader, type ReadListInterface } from '../src/readers.js';

const options = { credentials: new Map(), opcua: { pkiDir: '/nonexistent', trustFirstUse: false } };
const iface = (protocol: string, endpoint: string, address: string): ReadListInterface =>
  ({
    interfaceId: `pkg_1:${protocol}`,
    interfaceName: `InterfaceTemplateFor${protocol}`,
    protocol,
    endpoint,
    security: { mode: 'None' },
    intervalMs: 1000,
    tags: [{ tagId: 't1', propertyName: 'A', address, fields: {} }],
  }) as ReadListInterface;

describe('readers for the read list', () => {
  it('S7 gets the S7 reader, MC the MC reader and XGT the XGT reader — no connection until the first read', async () => {
    const s7 = await openReader(iface('S7', 's7://192.0.2.1?rack=0&slot=1', 'DB10.DBD4:REAL'), options);
    const mc = await openReader(iface('MC', 'melsec://192.0.2.2:5000?series=Q', 'D100'), options);
    const xgt = await openReader(iface('XGT', 'xgt://192.0.2.4:2004?series=XGK', 'D100'), options);
    try {
      expect(s7.constructor.name).toBe('S7Reader');
      expect(mc.constructor.name).toBe('McReader');
      expect(xgt.constructor.name).toBe('XgtReader');
    } finally {
      await s7.close();
      await mc.close();
      await xgt.close();
    }
  });

  it('a protocol this edge does not read fails with the reason the status reports', async () => {
    await expect(openReader(iface('BACNET', 'bacnet://192.0.2.3', '1'), options)).rejects.toThrow('BACNET is not read by this edge yet');
  });
});
