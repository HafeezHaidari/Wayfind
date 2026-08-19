import { debug } from "../log.js";

/**
 * §10 — "Overpass is a free shared service. Respect it."
 *
 * Respecting it means more than one query per city per generation. The public
 * instance publishes a hard concurrency limit at `/api/status`, and it is
 * **2 slots per client IP**. Exceed it and queries do not queue politely — they
 * come back 429, or 504 with "the server is probably too busy", which then
 * triggers a retry that consumes another slot and makes it worse.
 *
 * That is exactly what happened on a three-city trip: two generations in flight
 * at once (a client bug, since fixed) held both slots, and every retry stacked
 * on top. Tokyo's query answers in 30 seconds with a free slot and 504s in 5
 * without one.
 *
 * So the gate lives here, on the server, where it holds regardless of what the
 * client does. One Overpass query at a time, with a pause between them: half
 * the published allowance, which leaves room for anything else on this IP.
 */
export class Limiter {
  private active = 0;
  private lastFinishedAt = 0;
  private queue: (() => void)[] = [];

  constructor(
    private readonly label: string,
    private readonly maxConcurrent: number,
    private readonly minGapMs = 0,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const gap = this.minGapMs - (Date.now() - this.lastFinishedAt);
      if (gap > 0) await sleep(gap);
      return await task();
    } finally {
      this.lastFinishedAt = Date.now();
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    debug(`${this.label}: waiting for a slot (${this.queue.length + 1} queued)`);
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release() {
    this.active -= 1;
    this.queue.shift()?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One Overpass query at a time — half the published allowance of 2 — with a
 * second between them. A multi-city trip is slower this way and it completes,
 * which the stampeding version did not.
 */
export const overpassLimiter = new Limiter("Overpass", 1, 1000);

/** OSRM's demo server is likewise shared; one table request at a time. */
export const osrmLimiter = new Limiter("OSRM", 1, 250);

/**
 * The Wikimedia APIs are more generous than Overpass but still asked us to slow
 * down during the same incident, so they get a gate too.
 */
export const wikiLimiter = new Limiter("Wikimedia", 2, 150);
