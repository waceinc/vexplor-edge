/**
 * The remote collector's loop: register once, then poll the read list, read approved tags on their intervals, queue
 * batches on disk and send them signed (docs/edge-contract.md).
 *
 * Important: outbound only. Nothing here listens on a port; the server reaches the edge only through the read list it
 *    serves and the answers to batches. There is no command channel and no remote stop (STD-009 T10) — a revoked
 *    device stops by itself and keeps its queue.
 * Important: an outage costs no samples. Reading goes on while the server is unreachable; batches wait on disk and are
 *    sent in order with the same bootId and seq once it answers (the server stores each once).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

import type { ProtocolReader } from '@aas/collector';
import type { EdgeConfig } from './config.js';
import { HostMonitor, ServerLink, type HostProbe } from './health.js';
import { EdgeHttp, signerOf, type Signer } from './http.js';
import { loadOrCreateIdentity, saveIdentity, type Identity } from './identity.js';
import { DiskQueue, type Batch } from './queue.js';
import { InterfaceLink, type ReconnectPolicy } from './link.js';
import { openReader, type ReadListInterface, type Sample } from './readers.js';
import { Sender } from './sender.js';
import { checkRelease, type ReleaseManifest } from './update.js';
import { EDGE_VERSION } from './version.js';

export interface AgentOptions {
  config: EdgeConfig;
  credentials: Map<string, { userName: string; password: string }>;
  log?: (line: string) => void;
  now?: () => Date;
  /** Reconnecting to equipment (link.ts) — the defaults are what a release runs with */
  reconnect?: Partial<ReconnectPolicy>;
  /** How the PC is measured for `status.host` (health.ts) — a fake in tests */
  hostProbe?: HostProbe;
}

interface ReadList {
  revision: string;
  state: 'pending-approval' | 'approved' | 'paused';
  pollSeconds: number;
  interfaces: ReadListInterface[];
}

const HEARTBEAT_MS = 60_000;
/**
 * While sending is paused (outage, rate limit), samples go to disk at most once a minute or when a batch is full — not
 * every flush interval. Found by the 30-minute outage soak (2026-10-16): one batch a second piled up 1 769 batches, and
 * at the server's 60 requests a minute the backlog never shrank while new batches kept coming. A crash during an
 * outage now loses at most this much.
 */
const PAUSED_BATCH_MS = 60_000;
const UPDATE_CHECK_MS = 24 * 3600_000;
const SOFTWARE = { name: 'vexplor-edge', version: EDGE_VERSION };

export class EdgeAgent {
  readonly bootId = randomUUID();
  readonly config: EdgeConfig;
  readonly http: EdgeHttp;
  readonly queue: DiskQueue;
  readonly sender: Sender;
  identity: Identity;
  stopped: string | undefined;
  /** Samples read since start — what "nothing lost" is measured against */
  collected = 0;
  private seq = 0;
  private list: ReadList | undefined;
  private buffer: Sample[] = [];
  /** One per approved interface — each opens, reads and reconnects on its own (link.ts) */
  private links: InterfaceLink[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private updateTimer: ReturnType<typeof setInterval> | undefined;
  /** A newer signed release, reported — never installed by the edge */
  updateAvailable: ReleaseManifest | undefined;
  private sendAfter = 0;
  private lastBatchAt = 0;
  private readonly startedAt: string;
  private readonly host: HostMonitor;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly options: AgentOptions) {
    const { config } = options;
    this.config = config;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.startedAt = this.now().toISOString();
    this.identity = loadOrCreateIdentity(config.stateDir);
    // The line to the server is measured on the answers the edge gets anyway — no request is made for it
    const link = new ServerLink();
    this.host = new HostMonitor(config.stateDir, link.clock, options.hostProbe);
    this.http = new EdgeHttp({
      server: config.server,
      ...(config.proxy ? { proxy: config.proxy } : {}),
      ...(config.caFile ? { ca: readFileSync(config.caFile, 'utf8') } : {}),
      onAnswer: (sentAt, receivedAt, headers) => link.answered(sentAt, receivedAt, headers['date']),
    });
    this.queue = new DiskQueue(config.stateDir, config.maxQueuedBatches, config.maxQueueDays, () => this.now().getTime(), { log: this.log });
    this.sender = new Sender(this.http, this.queue, () => this.signer(), Math.random, link, this.now);
  }

  private signer(): Signer {
    return signerOf(this.identity.deviceId ?? 'register', this.identity.privateKeyPem);
  }

  /** Registers with a one-time code (first run only) */
  async register(code: string): Promise<Identity> {
    if (this.identity.deviceId) return this.identity;
    const answer = await this.http.request(this.signer(), 'POST', '/edge/v1/register', {
      schema: 'vexplor.edge.register/1',
      code,
      publicKey: this.identity.publicKey,
      // The PC's name goes along, so a person can tell collectors apart on the server's screen
      device: { name: this.options.config.name, hostname: hostname().slice(0, 200), software: SOFTWARE },
    });
    const body = answer.body as { deviceId?: string; registeredAt?: string; limits?: Identity['limits']; code?: string } | undefined;
    if (answer.status !== 201 || !body?.deviceId) throw new Error(`registration refused: ${answer.status} ${body?.code ?? ''}`.trim());
    this.identity = { ...this.identity, deviceId: body.deviceId, ...(body.registeredAt ? { registeredAt: body.registeredAt } : {}), ...(body.limits ? { limits: body.limits } : {}) };
    saveIdentity(this.options.config.stateDir, this.identity);
    return this.identity;
  }

  /** Whether the server lets this device read yet — asked once, right after registering, to say what comes next */
  async approvalState(): Promise<ReadList['state'] | undefined> {
    try {
      const answer = await this.http.request(this.signer(), 'GET', '/edge/v1/read-list', undefined, {});
      return answer.status === 200 ? (answer.body as ReadList).state : undefined;
    } catch {
      return undefined;
    }
  }

  async start(): Promise<void> {
    if (!this.identity.deviceId) throw new Error('not registered — run register with a code first');
    await this.poll();
    // Nothing a round throws may end the process — the next round tries again (a full disk ended it before 1.1.0)
    this.flushTimer = setInterval(() => void this.tick().catch((error: unknown) => this.log(`batching failed, trying again: ${(error as Error).message}`)), this.options.config.flushIntervalMs);
    if (this.options.config.update) {
      void this.checkUpdate();
      this.updateTimer = setInterval(() => void this.checkUpdate(), UPDATE_CHECK_MS);
    }
  }

  /** Fetches the release manifest and reports a newer signed release; downloads nothing (update.ts) */
  async checkUpdate(): Promise<void> {
    const update = this.options.config.update;
    if (!update || this.stopped) return;
    try {
      const answer = await this.http.getJson(update.manifestUrl);
      if (answer.status !== 200) return this.log(`update manifest: HTTP ${answer.status}`);
      const result = checkRelease(answer.body, update.publicKey, SOFTWARE.version);
      if (result.state === 'rejected') return this.log(`update manifest ignored: ${result.reason}`);
      if (result.state === 'available' && result.release.version !== this.updateAvailable?.version) {
        this.updateAvailable = result.release;
        this.log(`update available: ${result.release.version} — install it with the installer after approval; this edge does not install it`);
      }
    } catch (error) {
      this.log(`update manifest not reachable: ${(error as Error).message}`);
    }
  }

  async stop(reason = 'stopped'): Promise<void> {
    if (this.stopped === undefined) {
      this.stopped = reason;
      // Samples read but not yet batched go to disk — a service restart loses nothing; the next start sends them
      if (this.list && this.buffer.length > 0) this.enqueue(this.buffer.splice(0), this.now());
    }
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.updateTimer) clearInterval(this.updateTimer);
    await this.closeReaders();
  }

  /** Fetches the read list (304 when unchanged) and rebuilds readers when it changed */
  async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const answer = await this.http.request(this.signer(), 'GET', '/edge/v1/read-list', undefined, this.list ? { 'if-none-match': `"${this.list.revision}"` } : {});
      if (answer.status === 200) {
        const next = answer.body as ReadList;
        if (next.revision !== this.list?.revision) await this.apply(next);
        this.list = next;
      } else if (answer.status === 401 || answer.status === 403) {
        await this.halt(`read list refused: ${answer.status} ${(answer.body as { code?: string } | undefined)?.code ?? ''}`.trim());
        return;
      }
    } catch (error) {
      this.log(`read list not reachable: ${(error as Error).message}`);
    }
    this.pollTimer = setTimeout(() => void this.poll(), (this.list?.pollSeconds ?? 60) * 1000);
  }

  private async apply(list: ReadList): Promise<void> {
    await this.closeReaders();
    this.log(`read list ${list.revision} (${list.state}): ${list.interfaces.length} interface(s)`);
    if (list.state !== 'approved') return;
    const { opcua } = this.options.config;
    this.links = list.interfaces.map(
      (iface) =>
        new InterfaceLink({
          iface,
          open: (): Promise<ProtocolReader> => openReader(iface, { credentials: this.options.credentials, opcua }),
          ...(opcua.mode === 'subscribe' && iface.protocol === 'OPCUA' ? { subscribe: { deadband: opcua.deadband, resendMs: opcua.resendMs } } : {}),
          onSamples: (samples: Sample[]) => {
            this.collected += samples.length;
            this.buffer.push(...samples);
          },
          log: this.log,
          now: this.now,
          ...(this.options.reconnect ? { policy: this.options.reconnect } : {}),
        }),
    );
    // Opened together: a PLC that does not answer must not hold up the others
    await Promise.all(this.links.map((link) => link.start()));
  }

  private async closeReaders(): Promise<void> {
    const links = this.links.splice(0);
    await Promise.all(links.map((link) => link.close()));
  }

  private async halt(reason: string): Promise<void> {
    this.log(`ALARM: ${reason} — sending stopped, the queue is kept`);
    await this.stop(reason);
  }

  /** Turns buffered samples into batches on disk, then sends what the server will take */
  async tick(): Promise<void> {
    if (this.stopped || !this.list) return;
    const at = this.now();
    const limit = this.identity.limits?.maxSamplesPerBatch ?? 5000;
    const paused = at.getTime() < this.sendAfter;
    const due = !paused || this.buffer.length >= limit || at.getTime() - this.lastBatchAt >= PAUSED_BATCH_MS;
    if (due) {
      const samples = this.buffer.splice(0);
      const heartbeat = samples.length === 0 && at.getTime() - this.lastBatchAt >= HEARTBEAT_MS;
      if (samples.length > 0 || heartbeat) this.enqueue(samples, at, limit);
    }
    if (paused) return;
    const result = await this.sender.flush();
    if (result.state === 'wait') {
      this.sendAfter = at.getTime() + result.waitMs;
      this.log(`sending paused ${result.waitMs} ms: ${result.reason}`);
    } else if (result.state === 'stopped') {
      await this.halt(result.reason);
    }
    if (result.state !== 'stopped' && result.readListRevision && result.readListRevision !== this.list.revision) {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      void this.poll();
    }
  }

  /** Batches of at most `limit` samples on disk (one empty batch for a heartbeat) */
  private enqueue(samples: Sample[], at: Date, limit = this.identity.limits?.maxSamplesPerBatch ?? 5000): void {
    if (!this.list) return;
    for (let start = 0; start === 0 || start < samples.length; start += limit) {
      this.seq += 1;
      const batch: Batch = {
        schema: 'vexplor.edge.batch/1',
        bootId: this.bootId,
        seq: this.seq,
        readListRevision: this.list.revision,
        createdAt: at.toISOString(),
        samples: samples.slice(start, start + limit),
        status: this.status(),
      };
      this.queue.add(batch);
      this.lastBatchAt = at.getTime();
    }
  }

  /** Samples not yet handed to the server: still buffered, or in batches queued on disk */
  get pending(): number {
    return this.buffer.length + this.queue.files().reduce((sum, name) => sum + this.queue.read(name).samples.length, 0);
  }

  status(): Record<string, unknown> {
    return {
      startedAt: this.startedAt,
      queuedBatches: this.queue.size,
      droppedBatches: this.queue.dropped,
      software: SOFTWARE,
      interfaces: this.links.map((link) => link.status()),
      ...(this.updateAvailable ? { updateAvailable: this.updateAvailable.version } : {}),
      // 1.1.0: the PC and the line to the server (health.ts) — optional fields an older server ignores
      host: {
        ...this.host.status(this.now().getTime()),
        queuedInMemory: this.queue.inMemory,
        ...(this.queue.writeError ? { queueWriteError: this.queue.writeError.message, queueWriteErrorAt: this.queue.writeError.at } : {}),
      },
      server: this.sender.link.status(this.queue.oldestCreatedAt()),
    };
  }
}
