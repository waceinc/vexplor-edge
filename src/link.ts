/**
 * One approved interface's connection to its equipment, kept alive: opened, read on its intervals (or watched, OPC UA
 * subscribe), and closed and opened again when the equipment goes away.
 *
 * Important: the readers do not reconnect by themselves (1.0.0 defect, measured 2026-10-18). A Modbus reader keeps a
 *    closed socket, an MQTT reader keeps the error of a closed connection, an OPC UA reader is made with maxRetry 0 —
 *    after a PLC or broker restart every read returns `{ error }` (it does not throw). So the link counts reads that
 *    came back all errors; after `failures` of them in a row, or when opening fails, it closes the reader and opens it
 *    again after 1 s, 2 s, 4 s … at most 60 s (with jitter). The delay starts again from 1 s once a read succeeds.
 * Important: one link never holds up another. Each has its own timers; nothing here awaits another interface, the
 *    batching or the queue. A reader that does not answer within `readTimeoutMs` counts as a failed read.
 * Important: read only, as before — only `read` and `subscribe` are called on a reader.
 */
import type { ProtocolReader, ReadResult } from '@aas/collector';
import type { SubscribeOptions, ValueSubscription } from '@aas/opcua';
import { intervalGroups, isAnalogType, readGroup, sampleOf, type ReadListInterface, type ReadListTag, type Sample } from './readers.js';

/** A reader that can report changes itself (OPC UA) */
interface Subscriber {
  subscribe(sources: readonly string[], options: SubscribeOptions, onChange: (result: ReadResult) => void): Promise<ValueSubscription>;
}

export interface ReconnectPolicy {
  /** Reads in a row that came back all errors before the connection is opened again */
  failures: number;
  initialMs: number;
  maxMs: number;
  /** A read that has not answered by then counts as failed */
  readTimeoutMs: number;
}

export const RECONNECT: ReconnectPolicy = { failures: 3, initialMs: 1000, maxMs: 60_000, readTimeoutMs: 30_000 };

export interface LinkOptions {
  iface: ReadListInterface;
  open: () => Promise<ProtocolReader>;
  /** OPC UA report by exception (agent.watch before 1.0.1) — undefined to poll */
  subscribe?: { deadband: number; resendMs: number };
  onSamples: (samples: Sample[]) => void;
  log: (line: string) => void;
  now: () => Date;
  policy?: Partial<ReconnectPolicy>;
  random?: () => number;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 512);

export class InterfaceLink {
  private reader: ProtocolReader | undefined;
  private error: string | undefined;
  /** Reads in a row that came back all errors */
  private failed = 0;
  /** Opens tried since the last good read */
  private attempt = 0;
  /** The connection was lost (or never made): the next good read is logged as "connected again" */
  private lost = false;
  private closed = false;
  /** Bumped whenever the reader is dropped — a read or open that finishes afterwards is ignored */
  private generation = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private subscriptions: ValueSubscription[] = [];
  private readonly policy: ReconnectPolicy;

  constructor(private readonly options: LinkOptions) {
    this.policy = { ...RECONNECT, ...options.policy };
  }

  get interfaceId(): string {
    return this.options.iface.interfaceId;
  }

  start(): Promise<void> {
    return this.connect();
  }

  status(): { interfaceId: string; connected: boolean; lastError: string | null } {
    return { interfaceId: this.interfaceId, connected: this.reader !== undefined && this.error === undefined, lastError: this.error ?? null };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    await this.drop();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.retry = undefined;
    const generation = this.generation;
    let reader: ProtocolReader;
    try {
      reader = await this.options.open();
    } catch (error) {
      this.error = message(error);
      this.lostConnection(this.error);
      return;
    }
    if (this.closed || generation !== this.generation) {
      await safeClose(reader);
      return;
    }
    this.reader = reader;
    this.failed = 0;
    const subscriber = this.options.subscribe ? (reader as Partial<Subscriber>) : undefined;
    for (const [every, tags] of intervalGroups(this.options.iface)) {
      if (subscriber?.subscribe && (await this.watch(subscriber as Subscriber, every, tags, generation))) continue;
      if (generation !== this.generation) return;
      this.poll(every, tags, generation);
    }
  }

  /** Reads a group on its interval; never two reads of the group at once */
  private poll(every: number, tags: readonly ReadListTag[], generation: number): void {
    let busy = false;
    this.timers.push(
      setInterval(() => {
        const reader = this.reader;
        if (busy || !reader) return;
        busy = true;
        this.timed(readGroup(reader, tags, this.options.now))
          .then((samples) => {
            if (generation !== this.generation) return;
            this.options.onSamples(samples);
            this.judge(samples);
          })
          .catch((error: unknown) => {
            if (generation === this.generation) this.judge([], message(error));
          })
          .finally(() => (busy = false));
      }, every),
    );
  }

  /**
   * Report by exception (lead request §6 H4): the PLC samples the group on its interval and reports changes only (beyond
   * the deadband for numeric tags). An unchanged value is sent again every `resendMs` with a new receive time, so a
   * constant tag still shows as received. Returns false when the server refuses the subscription — the group is then
   * polled as before.
   * Important: a subscription goes quiet, without an error, when the server restarts. So one tag of the group is read
   *    as a check (every interval, 5–30 s); all errors count as a failed read like polling, and while a check fails the
   *    last values are not sent again as if they were fresh.
   */
  private async watch(reader: Subscriber, every: number, tags: readonly ReadListTag[], generation: number): Promise<boolean> {
    const { deadband, resendMs } = this.options.subscribe!;
    const byAddress = new Map<string, ReadListTag[]>();
    for (const tag of tags) byAddress.set(tag.address, [...(byAddress.get(tag.address) ?? []), tag]);
    const last = new Map<string, { sample: Sample; at: number }>();
    const take = (sample: Sample): void => {
      this.options.onSamples([sample]);
      last.set(sample.tagId, { sample, at: Date.parse(sample.receivedAt) });
    };
    try {
      const numeric = new Set(tags.filter((tag) => isAnalogType(tag.type)).map((tag) => tag.address));
      const subscription = await reader.subscribe([...byAddress.keys()], { samplingIntervalMs: every, deadband, numeric }, (result) => {
        if (generation !== this.generation) return;
        const receivedAt = this.options.now().toISOString();
        for (const tag of byAddress.get(result.source) ?? []) {
          const sample = sampleOf(tag, result, receivedAt);
          if (sample) take(sample);
        }
      });
      if (generation !== this.generation) {
        await subscription.close().catch(() => undefined);
        return true;
      }
      this.subscriptions.push(subscription);
    } catch (error) {
      this.options.log(`${this.interfaceId}: subscription refused, reading every ${every} ms instead — ${message(error)}`);
      return false;
    }
    this.timers.push(
      setInterval(() => {
        if (this.failed > 0 || this.error !== undefined) return;
        const now = this.options.now();
        for (const { sample, at } of [...last.values()]) {
          if (now.getTime() - at >= resendMs) take({ ...sample, receivedAt: now.toISOString() });
        }
      }, Math.min(resendMs, 60_000)),
    );
    const probe = tags.slice(0, 1);
    let busy = false;
    this.timers.push(
      setInterval(
        () => {
          const current = this.reader;
          if (busy || !current) return;
          busy = true;
          this.timed(readGroup(current, probe, this.options.now))
            .then((samples) => generation === this.generation && this.judge(samples))
            .catch((error: unknown) => generation === this.generation && this.judge([], message(error)))
            .finally(() => (busy = false));
        },
        Math.min(Math.max(every, 5000), 30_000),
      ),
    );
    return true;
  }

  /**
   * One read's outcome: all errors (or a read that threw) is a failed read; anything else — a value, or a value that has
   * not arrived yet — is a good one. A tag that fails while others are read leaves the connection as connected.
   */
  private judge(samples: Sample[], thrown?: string): void {
    const errors = samples.filter((sample) => sample.error !== undefined);
    const failed = thrown !== undefined || (samples.length > 0 && errors.length === samples.length);
    if (!failed) {
      this.error = undefined;
      this.failed = 0;
      if (this.lost) this.options.log(`${this.interfaceId}: connected again${this.attempt > 0 ? ` after ${this.attempt} attempt(s)` : ''}`);
      this.lost = false;
      this.attempt = 0;
      return;
    }
    this.error = thrown ?? errors[0]!.error;
    this.failed += 1;
    if (this.failed >= this.policy.failures) void this.lostConnection(`${this.policy.failures} reads in a row failed — ${this.error}`, true);
  }

  /** Closes what is left of the connection and opens it again after the backoff delay */
  private async lostConnection(reason: string, drop = false): Promise<void> {
    if (this.closed) return;
    if (drop) await this.drop();
    if (this.closed || this.retry) return;
    // Reader messages may run over several lines (node-opcua) — one line each in the journal
    reason = reason.replace(/\s+/g, ' ').trim();
    this.attempt += 1;
    const delay = this.delay(this.attempt);
    // One line when the connection goes, then only at attempts 2, 4, 8 … — a PLC off for a day is a few dozen lines
    if (!this.lost) this.options.log(`${this.interfaceId}: ${reason} — reconnecting in ${seconds(delay)} (backoff up to ${seconds(this.policy.maxMs)})`);
    else if ((this.attempt & (this.attempt - 1)) === 0) this.options.log(`${this.interfaceId}: reconnect attempt ${this.attempt - 1} failed — ${reason}; next in ${seconds(delay)}`);
    this.lost = true;
    this.retry = setTimeout(() => void this.connect(), delay);
  }

  /** initialMs × 2^(attempt−1), at most maxMs, then 75–100 % of that so many collectors do not knock at once */
  private delay(attempt: number): number {
    const base = Math.min(this.policy.maxMs, this.policy.initialMs * 2 ** Math.min(attempt - 1, 30));
    return Math.round(base * (0.75 + 0.25 * (this.options.random ?? Math.random)()));
  }

  /** Stops the timers and subscriptions and closes the reader; nothing here may throw */
  private async drop(): Promise<void> {
    this.generation += 1;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    const subscriptions = this.subscriptions.splice(0);
    const reader = this.reader;
    this.reader = undefined;
    this.failed = 0;
    await Promise.all(subscriptions.map((subscription) => safeClose(subscription)));
    if (reader) await safeClose(reader);
  }

  private timed<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer within ${seconds(this.policy.readTimeoutMs)}`)), this.policy.readTimeoutMs);
      work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
}

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

/** close() of a reader or subscription — a throw, a rejection or a hang of up to 10 s never reaches the caller */
async function safeClose(target: { close(): Promise<void> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(() => target.close()), new Promise<void>((resolve) => (timer = setTimeout(resolve, 10_000)))]);
  } catch {
    // A connection that is already gone may fail to close — it is dropped either way
  } finally {
    if (timer) clearTimeout(timer);
  }
}
