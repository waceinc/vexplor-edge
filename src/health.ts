/**
 * What the collector reports about itself in a batch's optional `status` (contract §5, 1.1.0): the PC it runs on
 * (`host`), its line to the server (`server`) and, per interface, how its equipment answers (`responseMs`, `readOkRatio`,
 * `reconnects`, `lastDisconnectAt`).
 *
 * Important: nothing here opens a connection or runs a command (STD-009 T9, T10). The PC is read through Node itself —
 *    `os`, `fs.statfs`, `/proc/meminfo` — and the server's clock from the `Date` header of answers the edge gets anyway.
 * Important: every field is optional and added only. A server that does not know a field ignores it (contract rule 6);
 *    a value that cannot be measured on this OS is left out, never sent as 0 or null.
 */
import { readFileSync, statfsSync } from 'node:fs';
import { cpus, freemem, totalmem, uptime } from 'node:os';

/** The host block is measured at most this often and repeated in the batches between — CPU is the average over it */
export const HOST_SAMPLE_MS = 30_000;
/** Reads (and opening attempts) per interface the ratio and response time look back over */
export const READ_WINDOW = 100;
/** Answered requests the round trip is averaged over */
export const ROUND_TRIP_WINDOW = 10;

export interface HostStatus {
  cpuPercent?: number;
  memoryUsedPercent?: number;
  diskFreeBytes?: number;
  diskFreePercent?: number;
  uptimeSeconds?: number;
  processUptimeSeconds?: number;
  clockOffsetMs?: number;
}

/** What the PC is asked — replaced by a fake in tests */
export interface HostProbe {
  cpuTimes(): { busy: number; total: number } | undefined;
  memory(): { total: number; available: number } | undefined;
  disk(path: string): { blockSize: number; blocks: number; available: number } | undefined;
  uptime(): number | undefined;
  processUptime(): number;
}

const attempt = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

/** MemAvailable — free memory plus what the kernel can take back from caches (Linux 3.14+) */
function linuxAvailable(): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  return match ? Number(match[1]) * 1024 : undefined;
}

export const nodeHostProbe: HostProbe = {
  cpuTimes: () =>
    attempt(() => {
      let busy = 0;
      let total = 0;
      for (const { times } of cpus()) {
        const all = times.user + times.nice + times.sys + times.idle + times.irq;
        total += all;
        busy += all - times.idle;
      }
      return total > 0 ? { busy, total } : undefined;
    }),
  memory: () =>
    attempt(() => {
      const total = totalmem();
      // Elsewhere freemem() leaves out caches the OS would give back — reported only where it means what Linux means
      const available = process.platform === 'linux' ? (attempt(linuxAvailable) ?? freemem()) : undefined;
      return available === undefined ? undefined : { total, available };
    }),
  disk: (path) =>
    attempt(() => {
      const stats = statfsSync(path);
      return { blockSize: Number(stats.bsize), blocks: Number(stats.blocks), available: Number(stats.bavail) };
    }),
  uptime: () => attempt(() => uptime()),
  processUptime: () => process.uptime(),
};

const round1 = (value: number): number => Math.round(value * 10) / 10;
const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

/**
 * The server's clock against ours, from the `Date` header of its answers. The header has whole seconds, so one answer
 * says only that the offset lies in [Date − sentAt, Date + 1 s − receivedAt]. The ranges of the last answers are
 * intersected, as NTP's interval method does, and the middle is reported; when they do not overlap (a clock was set)
 * the history starts again from the newest answer.
 */
export class ClockOffset {
  private ranges: { low: number; high: number }[] = [];

  add(sentAt: number, receivedAt: number, date: string | undefined): void {
    const server = date === undefined ? NaN : Date.parse(date);
    if (!Number.isFinite(server) || receivedAt < sentAt) return;
    this.ranges.push({ low: server - receivedAt, high: server + 1000 - sentAt });
    if (this.ranges.length > ROUND_TRIP_WINDOW) this.ranges.shift();
    if (this.bounds() === undefined) this.ranges = this.ranges.slice(-1);
  }

  private bounds(): { low: number; high: number } | undefined {
    if (this.ranges.length === 0) return undefined;
    const low = Math.max(...this.ranges.map((range) => range.low));
    const high = Math.min(...this.ranges.map((range) => range.high));
    return low <= high ? { low, high } : undefined;
  }

  /** Server time minus edge time in ms — positive when the server is ahead; undefined before the first answer */
  get offsetMs(): number | undefined {
    const bounds = this.bounds();
    return bounds ? Math.round((bounds.low + bounds.high) / 2) : undefined;
  }
}

/** The PC, measured at most every HOST_SAMPLE_MS */
export class HostMonitor {
  private last: { at: number; status: HostStatus } | undefined;
  private cpuBefore: { busy: number; total: number } | undefined;

  constructor(
    private readonly stateDir: string,
    private readonly clock: ClockOffset,
    private readonly probe: HostProbe = nodeHostProbe,
  ) {
    this.cpuBefore = probe.cpuTimes();
  }

  status(now: number): HostStatus {
    if (!this.last || now - this.last.at >= HOST_SAMPLE_MS) this.last = { at: now, status: this.measure() };
    const offset = this.clock.offsetMs;
    return { ...this.last.status, ...(offset === undefined ? {} : { clockOffsetMs: offset }) };
  }

  private measure(): HostStatus {
    const status: HostStatus = {};
    const cpu = this.probe.cpuTimes();
    if (cpu && this.cpuBefore && cpu.total > this.cpuBefore.total) {
      status.cpuPercent = round1(((cpu.busy - this.cpuBefore.busy) / (cpu.total - this.cpuBefore.total)) * 100);
    }
    this.cpuBefore = cpu;
    const memory = this.probe.memory();
    if (memory && memory.total > 0) status.memoryUsedPercent = round1(((memory.total - memory.available) / memory.total) * 100);
    const disk = this.probe.disk(this.stateDir);
    if (disk && disk.blocks > 0) {
      status.diskFreeBytes = disk.available * disk.blockSize;
      status.diskFreePercent = round1((disk.available / disk.blocks) * 100);
    }
    const up = this.probe.uptime();
    if (finite(up)) status.uptimeSeconds = Math.floor(up);
    status.processUptimeSeconds = Math.floor(this.probe.processUptime());
    for (const key of Object.keys(status) as (keyof HostStatus)[]) if (!finite(status[key])) delete status[key];
    return status;
  }
}

export interface ServerLinkStatus {
  lastSendOkAt: string | null;
  lastSendError: string | null;
  lastSendErrorAt: string | null;
  sendFailuresSinceOk: number;
  roundTripMs?: number;
  oldestQueuedAt: string | null;
}

/** The edge's line to the server: batches sent or not, and how long answers take */
export class ServerLink {
  private okAt: string | null = null;
  private error: { text: string; at: string } | null = null;
  private failures = 0;
  private trips: number[] = [];
  readonly clock = new ClockOffset();

  /** Any answered request to the server — its round trip (connection and TLS included) and its Date header */
  answered(sentAt: number, receivedAt: number, date: string | undefined): void {
    this.trips.push(receivedAt - sentAt);
    if (this.trips.length > ROUND_TRIP_WINDOW) this.trips.shift();
    this.clock.add(sentAt, receivedAt, date);
  }

  sendOk(at: Date): void {
    this.okAt = at.toISOString();
    this.failures = 0;
  }

  sendFailed(at: Date, reason: string): void {
    this.error = { text: reason.replace(/\s+/g, ' ').trim().slice(0, 512), at: at.toISOString() };
    this.failures += 1;
  }

  status(oldestQueuedAt: string | null): ServerLinkStatus {
    const trip = this.trips.length > 0 ? Math.round(this.trips.reduce((sum, ms) => sum + ms, 0) / this.trips.length) : undefined;
    return {
      lastSendOkAt: this.okAt,
      lastSendError: this.error?.text ?? null,
      lastSendErrorAt: this.error?.at ?? null,
      sendFailuresSinceOk: this.failures,
      ...(trip === undefined ? {} : { roundTripMs: trip }),
      oldestQueuedAt,
    };
  }
}

export interface EquipmentHealth {
  responseMs?: number;
  readOkRatio?: number;
  reconnects: number;
  lastDisconnectAt: string | null;
}

/** One interface's equipment: the last READ_WINDOW reads and opening attempts, and how often it came back */
export class EquipmentStats {
  private outcomes: boolean[] = [];
  private times: number[] = [];
  private opens = 0;
  private disconnectAt: string | null = null;

  /** A read that came back (ok: not all errors) after `ms` */
  read(ok: boolean, ms?: number): void {
    this.outcome(ok);
    if (ok && ms !== undefined && ms >= 0) {
      this.times.push(ms);
      if (this.times.length > READ_WINDOW) this.times.shift();
    }
  }

  /** Opening the connection succeeded (ok) or failed — a failed opening counts as a failed read */
  opened(ok: boolean): void {
    if (ok) this.opens += 1;
    else this.outcome(false);
  }

  /** The connection was found gone (it was up, or the first opening failed) */
  lost(at: Date): void {
    this.disconnectAt = at.toISOString();
  }

  private outcome(ok: boolean): void {
    this.outcomes.push(ok);
    if (this.outcomes.length > READ_WINDOW) this.outcomes.shift();
  }

  status(): EquipmentHealth {
    const good = this.outcomes.filter(Boolean).length;
    const time = this.times.length > 0 ? this.times.reduce((sum, ms) => sum + ms, 0) / this.times.length : undefined;
    return {
      ...(time === undefined ? {} : { responseMs: Math.round(time) }),
      ...(this.outcomes.length === 0 ? {} : { readOkRatio: Math.round((good / this.outcomes.length) * 1000) / 1000 }),
      // Openings after the first that succeeded — a PLC switched on late is not a reconnect
      reconnects: Math.max(0, this.opens - 1),
      lastDisconnectAt: this.disconnectAt,
    };
  }
}
