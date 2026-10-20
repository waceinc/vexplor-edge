/**
 * Reading equipment named by the approved read list — with the collector's own readers (@aas/opcua, @aas/fieldbus), so
 * the edge reads exactly as AAS Studio's server-side collector does.
 *
 * Important: read only. Only `read` is ever called on a reader; nothing here writes to a PLC.
 * Important: the read list is the whole truth about what to read. A device without an approved list reads nothing;
 *    tags are grouped by their interval (a tag's own intervalMs overrides the interface's).
 * Important: a reading that has not arrived yet (`pending`) makes no sample — no fake value in the time series.
 * Important: a login (`credentialRef`) is looked up in the credentials file for OPC UA and, since 1.1.0, MQTT.
 * Important: S7 and MC (since 1.2.0) and XGT (LS ELECTRIC, the release after 1.2.0) are VEXPLOR extension bindings,
 *    read only — Read Var, Batch Read and the XGT read request (0x0054) are the only frames their readers build. They have no login; the readers connect on the first read, so a PLC that is off makes
 *    failed reads (and the link's reconnect), not a failed open.
 */
import type { AidInterface, ProtocolReader, ReadResult } from '@aas/collector';

export interface ReadListTag {
  tagId: string;
  propertyName: string;
  address: string;
  key?: string;
  type?: string;
  unit?: string;
  fields: Record<string, string>;
  intervalMs?: number;
}

export interface ReadListInterface {
  interfaceId: string;
  interfaceName: string;
  protocol: 'OPCUA' | 'MODBUS' | 'MQTT' | 'HTTP' | 'S7' | 'MC' | 'XGT';
  endpoint: string;
  security: { mode: string; policy?: string; credentialRef?: string };
  intervalMs: number;
  tags: ReadListTag[];
}

export type Sample = { tagId: string; observedAt: string; receivedAt: string; value: number | string | boolean | null; quality?: string; error?: string };

export interface OpenOptions {
  credentials: Map<string, { userName: string; password: string }>;
  opcua: { pkiDir: string; trustFirstUse: boolean };
}

/**
 * AID value types the deadband applies to — analog values only (float, double, decimal).
 * Important: not integers. A counter going up by 1 under a deadband of 1 lost every other step in the H4 measurement
 *    (ProductionCount 100 → 50 in 5 minutes); counts, states and codes are sent on every change.
 */
export const isAnalogType = (type: string | undefined): boolean => type !== undefined && /float|double|decimal/i.test(type);

/** The read list's interface in the shape the collector's readers take */
export function toAidInterface(iface: ReadListInterface): AidInterface {
  return {
    name: iface.interfaceName,
    protocol: iface.protocol,
    base: iface.endpoint,
    properties: iface.tags.map((tag) => ({
      name: tag.propertyName,
      observable: false,
      href: tag.address,
      formFields: { ...tag.fields },
      ...(tag.key !== undefined ? { key: tag.key } : {}),
      ...(tag.type !== undefined ? { type: tag.type } : {}),
      ...(tag.unit !== undefined ? { unit: tag.unit } : {}),
    })),
  };
}

/** Opens a reader for one interface; throws with a reason the status block reports */
export async function openReader(iface: ReadListInterface, options: OpenOptions): Promise<ProtocolReader> {
  if (iface.protocol === 'OPCUA') {
    const { OpcUaReader } = await import('@aas/opcua');
    const ref = iface.security.credentialRef;
    const user = ref ? options.credentials.get(ref) : undefined;
    if (ref && !user) throw new Error(`no credential named ${ref} in the credentials file`);
    const mode = iface.security.mode as 'None' | 'Sign' | 'SignAndEncrypt';
    return OpcUaReader.connect({
      endpoint: iface.endpoint,
      ...(mode !== 'None' ? { security: { mode, ...(iface.security.policy ? { policy: iface.security.policy } : {}) } } : {}),
      ...(user ? { user } : {}),
      pkiDir: options.opcua.pkiDir,
      trustUnknownServer: options.opcua.trustFirstUse,
    });
  }
  if (iface.protocol === 'MODBUS') return (await import('@aas/fieldbus')).ModbusReader.connect(toAidInterface(iface));
  if (iface.protocol === 'S7') return (await import('@aas/fieldbus')).S7Reader.connect(toAidInterface(iface));
  if (iface.protocol === 'MC') return (await import('@aas/fieldbus')).McReader.connect(toAidInterface(iface));
  if (iface.protocol === 'XGT') return (await import('@aas/fieldbus')).XgtReader.connect(toAidInterface(iface));
  if (iface.protocol === 'MQTT') {
    const ref = iface.security.credentialRef;
    const user = ref ? options.credentials.get(ref) : undefined;
    if (ref && !user) throw new Error(`no credential named ${ref} in the credentials file`);
    const { MqttReader } = await import('@aas/fieldbus');
    if (!user) return MqttReader.connect(toAidInterface(iface));
    // Important: the login goes into the address only for the connection, in memory on this PC — the read list never
    //    carries it (AAS Studio 2.8.0 lists `credentialRef` only). This form works with every @aas/fieldbus release.
    //    The reader handed back reports the listed address, so no log or status line can show the password.
    const reader = await MqttReader.connect({ ...toAidInterface(iface), base: withLogin(iface.endpoint, user) });
    return { base: iface.endpoint, read: (sources) => reader.read(sources), close: () => reader.close() };
  }
  throw new Error(`${iface.protocol} is not read by this edge yet`);
}

/** An mqtt:// or mqtts:// address with a user name and password in it — percent-encoded, as the reader decodes it */
export function withLogin(endpoint: string, user: { userName: string; password: string }): string {
  const url = new URL(endpoint.replace(/^mqtt(s?):/i, 'http$1:'));
  url.username = user.userName;
  url.password = user.password;
  return url.toString().replace(/^http(s?):/i, 'mqtt$1:').replace(/\/$/, endpoint.endsWith('/') ? '/' : '');
}

/** Tags of an interface grouped by their effective interval */
export function intervalGroups(iface: ReadListInterface): Map<number, ReadListTag[]> {
  const groups = new Map<number, ReadListTag[]>();
  for (const tag of iface.tags) {
    const every = tag.intervalMs ?? iface.intervalMs;
    groups.set(every, [...(groups.get(every) ?? []), tag]);
  }
  return groups;
}

/** A contract value from whatever the reader returned — numbers, text and booleans as they are, the rest as JSON */
function valueOf(value: unknown): Sample['value'] {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  return JSON.stringify(value);
}

/** One reading result as a sample — undefined while no value has arrived yet (pending) */
export function sampleOf(tag: ReadListTag, result: ReadResult, receivedAt: string): Sample | undefined {
  if (result.pending) return undefined;
  return {
    tagId: tag.tagId,
    observedAt: result.observedAt ?? receivedAt,
    receivedAt,
    value: result.error ? null : valueOf(result.value),
    ...(result.quality ? { quality: result.quality.slice(0, 64) } : {}),
    ...(result.error ? { error: result.error.slice(0, 512) } : {}),
  };
}

/** One reading of a group of tags as samples */
export async function readGroup(reader: ProtocolReader, tags: readonly ReadListTag[], now: () => Date = () => new Date()): Promise<Sample[]> {
  const results: ReadResult[] = await reader.read(tags.map((tag) => tag.address));
  const receivedAt = now().toISOString();
  const out: Sample[] = [];
  results.forEach((result, index) => {
    const tag = tags[index];
    const sample = tag ? sampleOf(tag, result, receivedAt) : undefined;
    if (sample) out.push(sample);
  });
  return out;
}
