/**
 * File operations that ride out a file held open for a moment.
 *
 * Important: on Windows, antivirus and the search indexer open a file the moment it is written; renaming or deleting it
 *    fails for that moment with EPERM, EBUSY or EACCES. The same retry is harmless elsewhere — on Linux these codes are
 *    a lasting permission problem, and the short wait only delays the same error.
 * Important: the wait is synchronous (the queue is synchronous) and short — 6 tries, about 0.3 s in all, only when an
 *    operation fails. Anything longer is handled by the caller (the batch waits in memory, a sent file is deleted later).
 */
const HELD = new Set(['EPERM', 'EBUSY', 'EACCES']);
const WAITS_MS = [10, 20, 40, 80, 160];
const pause = new Int32Array(new SharedArrayBuffer(4));

export const heldOpen = (error: unknown): boolean => HELD.has((error as NodeJS.ErrnoException | undefined)?.code ?? '');

/** Runs `operation`, retrying while the file is held open; throws the last error when it never goes through */
export function retryHeld<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!heldOpen(error) || attempt >= WAITS_MS.length) throw error;
      Atomics.wait(pause, 0, 0, WAITS_MS[attempt]);
    }
  }
}
