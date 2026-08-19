import type { Preferences, TravelMatrix } from "../../shared/types.js";
import { env } from "../env.js";
import { fetchJson } from "./http.js";
import { debug } from "../log.js";
import type { Counters } from "./counters.js";
import { osrmLimiter } from "./limiter.js";
import { key } from "../../core/travel.js";
import { estimateMinutes } from "../../core/travel.js";
import { walkingDistanceM } from "../../shared/geo.js";
import { WALK_SPEED_M_PER_MIN } from "../../shared/planning-config.js";
import { fixtureSlug, readFixture } from "./fixtures.js";

/**
 * §5d — the travel-time matrix, computed once per city per generation.
 *
 * A finding worth stating plainly: the public OSRM demo server answers every
 * profile in the URL with the same numbers, and those numbers are car speeds
 * (~32 km/h through central Porto). `/table/v1/foot/...` is not a walking
 * router there. So this module uses OSRM for what it genuinely provides — real
 * road-network *distances* — and derives walking time from those at a stated
 * pace, rather than passing off driving times as walking times. Car mode uses
 * OSRM's durations directly, which is what they actually are. Self-hosting an
 * OSRM foot profile would fix this; see the README.
 */

export type MatrixPoint = { id: string; lat: number; lng: number };

/** The demo server's table service caps coordinates per request. */
export const MAX_MATRIX_POINTS = 95;

type OsrmTableResponse = {
  code: string;
  durations?: (number | null)[][];
  distances?: (number | null)[][];
  message?: string;
};

export async function buildTravelMatrix(
  points: MatrixPoint[],
  mode: Preferences["transport"],
  counters: Counters,
  cityName: string,
): Promise<TravelMatrix> {
  if (points.length < 2) return { mode, approximate: true, durations: {}, distances: {} };

  if (env.fixtureMode) {
    counters.osrmCalls += 1;
    const recorded = readFixture<TravelMatrix>(fixtureSlug(cityName), "matrix.json");
    return retimeForMode(recorded, mode);
  }

  const used = points.slice(0, MAX_MATRIX_POINTS);
  const coords = used.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const url = `${env.osrmUrl}/table/v1/driving/${coords}?annotations=duration,distance`;

  counters.osrmCalls += 1;
  const body = await osrmLimiter.run(() =>
    fetchJson<OsrmTableResponse>(url, { label: "OSRM", timeoutMs: 60_000 }),
  );
  if (body.code !== "Ok" || !body.distances) {
    throw new Error(`OSRM returned ${body.code}${body.message ? `: ${body.message}` : ""}`);
  }

  const durations: Record<string, number> = {};
  const distances: Record<string, number> = {};

  for (let i = 0; i < used.length; i++) {
    for (let j = 0; j < used.length; j++) {
      if (i === j) continue;
      const metres = body.distances[i]?.[j];
      const seconds = body.durations?.[i]?.[j];
      const pair = key(used[i].id, used[j].id);
      if (typeof metres === "number" && Number.isFinite(metres)) {
        distances[pair] = metres;
        durations[pair] =
          mode === "car" && typeof seconds === "number"
            ? seconds / 60
            : minutesFromRoadDistance(metres, mode);
      }
    }
  }

  debug(`OSRM matrix: ${used.length} points, ${Object.keys(durations).length} pairs`);
  return { mode, approximate: mode !== "car", durations, distances };
}

/**
 * A recorded matrix stores road distances, which do not change with the mode;
 * only the time we derive from them does.
 */
export function retimeForMode(matrix: TravelMatrix, mode: Preferences["transport"]): TravelMatrix {
  const durations: Record<string, number> = {};
  for (const [pair, metres] of Object.entries(matrix.distances)) {
    durations[pair] = minutesFromRoadDistance(metres, mode);
  }
  return { mode, approximate: true, durations, distances: matrix.distances };
}

function minutesFromRoadDistance(metres: number, mode: Preferences["transport"]): number {
  return mode === "walk" ? metres / WALK_SPEED_M_PER_MIN : estimateMinutes(metres, mode);
}

/** Straight-line fallback, used when OSRM is unreachable (§12: report, don't pay). */
export function estimatedMatrix(points: MatrixPoint[], mode: Preferences["transport"]): TravelMatrix {
  const durations: Record<string, number> = {};
  const distances: Record<string, number> = {};
  for (const a of points) {
    for (const b of points) {
      if (a.id === b.id) continue;
      const metres = walkingDistanceM(a, b);
      distances[key(a.id, b.id)] = metres;
      durations[key(a.id, b.id)] = minutesFromRoadDistance(metres, mode);
    }
  }
  return { mode, approximate: true, durations, distances };
}
