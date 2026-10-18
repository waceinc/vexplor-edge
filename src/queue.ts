/**
 * The local queue (docs/edge-contract.md §6): every batch is on disk before it is sent and deleted only after a 2xx.
 *
 * Important: written to a temporary name and renamed — a power cut leaves either the whole batch or none, never half a
 *    file that would be refused as BadRequest and lost.
 * Important: bounded by count and by age. Past `max` batches, or older than `maxDays` (default 30), the oldest are dropped
 *    and counted (`droppedBatches` in the next status) —
 *    never silently. A refused batch (400/413/422) moves to refused/ for a person to look at; it is not resent.
 * Important: a full disk does not stop the collector (1.1.0). Before, the failed write threw inside the flush timer and
 *    Node ended the process. A batch that cannot be written now waits in memory — at most `memoryBatches` batches and
 *    `memorySamples` samples, the oldest dropped and counted beyond that — is sent from there like any other, and is
 *    written to disk first thing once a write works again. One log line when writing fails, one when it works again.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Batch {
  schema: 'vexplor.edge.batch/1';
  bootId: string;
  seq: number;
  readListRevision: string;
  createdAt: string;
  samples: { tagId: string; observedAt: string; receivedAt: string; value: number | string | boolean | null; quality?: string; error?: string }[];
  status?: Record<string, unknown>;
}

/** The creation time from a queue file name (nameOf) — no file is opened to judge its age */
function createdOf(name: string): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
  if (!match) return undefined;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(at) ? at : undefined;
}

export interface QueueOptions {
  log?: (line: string) => void;
  /** Batches kept in memory while the disk takes none. Default 1 000 */
  memoryBatches?: number;
  /** Samples kept in memory while the disk takes none. Default 100 000 */
  memorySamples?: number;
}

export class DiskQueue {
  private readonly queueDir: string;
  private readonly refusedDir: string;
  dropped = 0;
  /** Batches that could not be written, by the name they would have on disk — sent from here */
  private readonly memory = new Map<string, Batch>();
  /** The last failed write, kept after writing works again (like lastSendError) */
  writeError: { message: string; at: string } | null = null;
  private failing = false;

  constructor(
    stateDir: string,
    private readonly max: number,
    /** Unsent batches older than this are dropped and counted (contract §6 — receivers keep their duplicate memory at least this long) */
    private readonly maxDays = 30,
    private readonly now: () => number = Date.now,
    private readonly options: QueueOptions = {},
  ) {
    this.queueDir = join(stateDir, 'queue');
    this.refusedDir = join(stateDir, 'refused');
    mkdirSync(this.queueDir, { recursive: true });
    mkdirSync(this.refusedDir, { recursive: true });
  }

  private nameOf(batch: Pick<Batch, 'bootId' | 'seq' | 'createdAt'>): string {
    // createdAt first so batches of different boots still sort in the order they were made
    return `${batch.createdAt.replace(/[:.]/g, '-')}_${batch.bootId}_${String(batch.seq).padStart(10, '0')}.json`;
  }

  /** Writes one batch whole (temporary name, then rename); false when the disk refused it */
  private write(name: string, batch: Batch): boolean {
    const temporary = join(this.queueDir, `${name}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(batch));
      renameSync(temporary, join(this.queueDir, name));
    } catch (error) {
      rmSync(temporary, { force: true });
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 512);
      this.writeError = { message, at: new Date(this.now()).toISOString() };
      if (!this.failing) this.options.log?.(`queue: cannot write to disk, keeping batches in memory and sending them from there — ${message}`);
      this.failing = true;
      return false;
    }
    if (this.failing) this.options.log?.('queue: writing to disk again');
    this.failing = false;
    return true;
  }

  add(batch: Batch): void {
    // What waits in memory is older — it goes to disk first, in order
    for (const [waiting, held] of this.memory) {
      if (!this.write(waiting, held)) break;
      this.memory.delete(waiting);
    }
    const name = this.nameOf(batch);
    if (this.memory.size > 0 || !this.write(name, batch)) {
      this.memory.set(name, batch);
      this.bound();
      return;
    }
    const files = this.diskFiles();
    const cutoff = this.now() - this.maxDays * 86_400_000;
    const tooOld = files.filter((file) => {
      const created = createdOf(file);
      return created !== undefined && created < cutoff;
    });
    const tooMany = files.filter((file) => !tooOld.includes(file)).slice(0, Math.max(0, files.length - tooOld.length - this.max));
    for (const old of [...tooOld, ...tooMany]) {
      unlinkSync(join(this.queueDir, old));
      this.dropped += 1;
    }
  }

  /** Drops the oldest batches in memory beyond its bounds, counted in `dropped` */
  private bound(): void {
    const maxBatches = this.options.memoryBatches ?? 1000;
    const maxSamples = this.options.memorySamples ?? 100_000;
    let samples = [...this.memory.values()].reduce((sum, held) => sum + held.samples.length, 0);
    for (const [name, held] of this.memory) {
      if (this.memory.size <= maxBatches && samples <= maxSamples) break;
      this.memory.delete(name);
      samples -= held.samples.length;
      this.dropped += 1;
    }
  }

  private diskFiles(): string[] {
    return readdirSync(this.queueDir).filter((name) => name.endsWith('.json')).sort();
  }

  /** Batches waiting to be sent, oldest first — on disk and, while the disk takes none, in memory */
  files(): string[] {
    return [...this.diskFiles(), ...this.memory.keys()].sort();
  }

  /** Batches waiting in memory because the disk took none */
  get inMemory(): number {
    return this.memory.size;
  }

  /** When the oldest unsent batch was made (from its file name), or null when nothing waits */
  oldestCreatedAt(): string | null {
    const first = this.files()[0];
    const at = first === undefined ? undefined : createdOf(first);
    return at === undefined ? null : new Date(at).toISOString();
  }

  get size(): number {
    return this.files().length;
  }

  read(name: string): Batch {
    const held = this.memory.get(name);
    if (held) return held;
    return JSON.parse(readFileSync(join(this.queueDir, name), 'utf8')) as Batch;
  }

  done(name: string): void {
    if (this.memory.delete(name)) return;
    if (existsSync(join(this.queueDir, name))) unlinkSync(join(this.queueDir, name));
  }

  refuse(name: string): void {
    const held = this.memory.get(name);
    if (held) {
      this.memory.delete(name);
      // Kept for a person to look at when the disk takes it; refused either way, never resent
      try {
        writeFileSync(join(this.refusedDir, name), JSON.stringify(held));
      } catch {
        // The server refused it and the disk is full — counted as refused by the sender
      }
      return;
    }
    renameSync(join(this.queueDir, name), join(this.refusedDir, name));
  }
}
