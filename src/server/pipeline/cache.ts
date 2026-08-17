import type { Counters } from "./counters.js";
import { debug } from "../log.js";

/**
 * §5e — an in-memory, process-lifetime cache holding third-party POI records
 * only. It never sees a `TripBrief`, never anything identifying a user, and is
 * never written to disk. It dies with the process.
 *
 * It exists because re-querying Overpass for the same city on every refinement
 * is both slow and rude to a free public service (§8, §10).
 */

type Entry<T> = { value: T; storedAt: number };

/** Long enough to cover a planning session, short enough that OSM edits land. */
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 24;

export class PoiCache<T> {
  private entries = new Map<string, Entry<T>>();

  /**
   * Keys are city plus category set — never anything user-specific (§5e).
   */
  static keyFor(cityName: string, categoryKeys: string[]): string {
    return `${cityName.toLowerCase().trim()}::${[...categoryKeys].sort().join(",")}`;
  }

  get(key: string, counters: Counters): T | null {
    const hit = this.entries.get(key);
    if (!hit || Date.now() - hit.storedAt > TTL_MS) {
      if (hit) this.entries.delete(key);
      counters.cacheMisses += 1;
      return null;
    }
    counters.cacheHits += 1;
    debug(`cache hit for ${key}`);
    return hit.value;
  }

  set(key: string, value: T) {
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    this.entries.set(key, { value, storedAt: Date.now() });
  }

  clear() {
    this.entries.clear();
  }
}
