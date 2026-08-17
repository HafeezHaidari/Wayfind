import { TWO_OPT_MAX_PASSES } from "../shared/planning-config.js";

/**
 * §7a step 4 — order a day's stops. Nearest-neighbour from the day's first
 * fixed point, then a 2-opt improvement pass. With five to eight stops in a day
 * this is microseconds, and 2-opt reliably removes the crossings that plain
 * nearest-neighbour leaves behind.
 *
 * Stops the user pinned to a time are a fixed skeleton: their relative order is
 * the order of their pinned times and no move may disturb it (§8).
 */

export type Cost = (fromId: string, toId: string) => number;

export type SequenceOptions = {
  /** Where the day begins — the basecamp, or null to start at the first stop. */
  startId?: string | null;
  /** Ids whose relative order is fixed, already in the order they must appear. */
  fixedOrder?: string[];
};

export function sequenceStops(ids: string[], cost: Cost, options: SequenceOptions = {}): string[] {
  if (ids.length <= 1) return [...ids];
  const fixed = (options.fixedOrder ?? []).filter((id) => ids.includes(id));

  const initial =
    fixed.length > 0
      ? insertAroundSkeleton(ids, fixed, cost, options.startId ?? null)
      : nearestNeighbour(ids, cost, options.startId ?? null);

  return twoOpt(initial, cost, options.startId ?? null, fixed);
}

function nearestNeighbour(ids: string[], cost: Cost, startId: string | null): string[] {
  const remaining = new Set(ids);
  const route: string[] = [];
  let current = startId;

  if (current === null) {
    // No fixed origin: begin at the stop with the cheapest onward hop, which
    // tends to start the day inside the densest part of the cluster.
    let bestId = ids[0];
    let bestCost = Infinity;
    for (const id of ids) {
      const nearest = Math.min(...ids.filter((o) => o !== id).map((o) => cost(id, o)));
      if (nearest < bestCost) {
        bestCost = nearest;
        bestId = id;
      }
    }
    route.push(bestId);
    remaining.delete(bestId);
    current = bestId;
  }

  while (remaining.size > 0) {
    let bestId: string | null = null;
    let bestCost = Infinity;
    for (const id of remaining) {
      const c = cost(current, id);
      if (c < bestCost) {
        bestCost = c;
        bestId = id;
      }
    }
    route.push(bestId!);
    remaining.delete(bestId!);
    current = bestId!;
  }
  return route;
}

/**
 * Cheapest insertion around a fixed skeleton: each free stop goes wherever it
 * adds the least travel, without ever moving a pinned stop out of order.
 */
function insertAroundSkeleton(
  ids: string[],
  skeleton: string[],
  cost: Cost,
  startId: string | null,
): string[] {
  const route = [...skeleton];
  const free = ids.filter((id) => !skeleton.includes(id));

  for (const id of free) {
    let bestPos = route.length;
    let bestDelta = Infinity;
    for (let pos = 0; pos <= route.length; pos++) {
      const before = pos === 0 ? startId : route[pos - 1];
      const after = pos === route.length ? null : route[pos];
      const delta =
        (before ? cost(before, id) : 0) +
        (after ? cost(id, after) : 0) -
        (before && after ? cost(before, after) : 0);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestPos = pos;
      }
    }
    route.splice(bestPos, 0, id);
  }
  return route;
}

function twoOpt(route: string[], cost: Cost, startId: string | null, fixed: string[]): string[] {
  if (route.length < 3) return route;
  const best = [...route];

  for (let pass = 0; pass < TWO_OPT_MAX_PASSES; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        if (!preservesFixedOrder(candidate, fixed)) continue;
        if (pathCost(candidate, cost, startId) < pathCost(best, cost, startId) - 1e-9) {
          best.splice(0, best.length, ...candidate);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

function preservesFixedOrder(route: string[], fixed: string[]): boolean {
  if (fixed.length < 2) return true;
  const positions = fixed.map((id) => route.indexOf(id));
  return positions.every((p, i) => i === 0 || p > positions[i - 1]);
}

export function pathCost(route: string[], cost: Cost, startId: string | null): number {
  let total = 0;
  let prev = startId;
  for (const id of route) {
    if (prev) total += cost(prev, id);
    prev = id;
  }
  return total;
}
