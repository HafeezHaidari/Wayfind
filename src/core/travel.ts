import type { Preferences, TravelMatrix } from "../shared/types.js";
import type { LatLng } from "../shared/geo.js";
import { walkingDistanceM } from "../shared/geo.js";
import {
  CAR_FLOOR_MIN,
  CAR_MULTIPLIER,
  SHORT_HOP_WALK_MIN,
  TAXI_FLOOR_MIN,
  TAXI_MULTIPLIER,
  TRANSIT_FLOOR_MIN,
  TRANSIT_MULTIPLIER,
  WALK_SPEED_M_PER_MIN,
} from "../shared/planning-config.js";

/**
 * Travel time lookup. The matrix is computed once per city per generation
 * (§5d); everything here is a pure read of it, so the scheduler stays offline
 * and testable.
 *
 * When the matrix has no entry for a pair — a synthetic matrix in a test, a
 * POI OSRM could not snap to a road — the estimate falls back to straight-line
 * distance with a detour factor. That is worse than a routed answer but it is
 * never a fabricated precision: the UI labels non-routed modes approximate.
 */

export const BASECAMP_ID = "basecamp";

export function key(fromId: string, toId: string): string {
  return `${fromId}|${toId}`;
}

export function travelMinutes(
  matrix: TravelMatrix | null,
  fromId: string,
  toId: string,
  from: LatLng,
  to: LatLng,
  mode: Preferences["transport"],
): number {
  if (fromId === toId) return 0;
  const routed = matrix?.durations[key(fromId, toId)];
  if (typeof routed === "number" && Number.isFinite(routed)) return Math.round(routed);
  return Math.round(estimateMinutes(walkMetresBetween(matrix, fromId, toId, from, to), mode));
}

/** Metres of walking a leg actually costs the traveller, for the §7d cap. */
export function walkingLoadM(
  matrix: TravelMatrix | null,
  fromId: string,
  toId: string,
  from: LatLng,
  to: LatLng,
  mode: Preferences["transport"],
): number {
  const metres = walkMetresBetween(matrix, fromId, toId, from, to);
  if (mode === "walk") return metres;
  if (mode === "transit") {
    // Transit still means walking to the stop and away from it at the far end,
    // but not the whole distance. Short hops are walked outright.
    return Math.min(metres, TRANSIT_ACCESS_WALK_M * 2);
  }
  return 0; // door to door
}

/** Assumed walk to or from a transit stop, in metres. */
const TRANSIT_ACCESS_WALK_M = 350;

function walkMetresBetween(
  matrix: TravelMatrix | null,
  fromId: string,
  toId: string,
  from: LatLng,
  to: LatLng,
): number {
  const recorded = matrix?.distances[key(fromId, toId)];
  if (typeof recorded === "number" && Number.isFinite(recorded)) return recorded;
  return walkingDistanceM(from, to);
}

/**
 * §5d — transit is not routed. A calibrated multiplier over walking time with a
 * floor for waiting and interchange is honest about what it is; a GTFS-less
 * "transit time" quoted to the minute is not.
 */
export function estimateMinutes(metres: number, mode: Preferences["transport"]): number {
  const walkMin = metres / WALK_SPEED_M_PER_MIN;
  if (mode === "walk" || walkMin <= SHORT_HOP_WALK_MIN) return walkMin;
  switch (mode) {
    case "transit":
      return Math.max(TRANSIT_FLOOR_MIN, walkMin * TRANSIT_MULTIPLIER);
    case "taxi":
      return Math.max(TAXI_FLOOR_MIN, walkMin * TAXI_MULTIPLIER);
    case "car":
      return Math.max(CAR_FLOOR_MIN, walkMin * CAR_MULTIPLIER);
    default:
      return walkMin;
  }
}

/** Whether times for this mode are estimates rather than routed (§5d, UI label). */
export function isApproximate(mode: Preferences["transport"], matrix: TravelMatrix | null): boolean {
  if (mode === "transit") return true;
  return matrix?.approximate ?? true;
}

export function emptyMatrix(mode: Preferences["transport"]): TravelMatrix {
  return { mode, approximate: true, durations: {}, distances: {} };
}
