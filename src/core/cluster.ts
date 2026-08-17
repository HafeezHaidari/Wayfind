import type { LatLng } from "../shared/geo.js";
import {
  BASECAMP_BIAS,
  KMEANS_MAX_ITERATIONS,
  KMEANS_RESTARTS,
} from "../shared/planning-config.js";

/**
 * §7a step 2 — cluster candidate POIs geographically into one group per day so
 * a day does not zigzag across the city. k-means with k-means++ seeding, a
 * balancing pass so days come out comparable in size, and an optional pull
 * toward the basecamp when the user gave one.
 *
 * Deterministic by construction: the RNG is seeded from the input, so the same
 * candidate set always produces the same clusters. A planner that reshuffles
 * the whole trip when you remove one stop is not trustworthy.
 */

export type ClusterInput = {
  points: LatLng[];
  k: number;
  basecamp: LatLng | null;
};

/** Cluster index per input point, plus each cluster's centre. */
export type ClusterResult = {
  assignment: number[];
  centres: LatLng[];
};

export function clusterByGeography({ points, k, basecamp }: ClusterInput): ClusterResult {
  const n = points.length;
  const clusters = Math.max(1, Math.min(k, n));
  if (n === 0) return { assignment: [], centres: [] };
  if (clusters === 1) return { assignment: points.map(() => 0), centres: [meanOf(points)] };

  const projected = projectAll(points);
  const anchor = basecamp ? project(basecamp, points[0].lat) : null;

  let best: { assignment: number[]; inertia: number; centres: Point[] } | null = null;

  for (let restart = 0; restart < KMEANS_RESTARTS; restart++) {
    const rng = mulberry32(seedFrom(points, restart));
    let centres = seedPlusPlus(projected, clusters, rng);
    let assignment = new Array<number>(n).fill(0);

    for (let iter = 0; iter < KMEANS_MAX_ITERATIONS; iter++) {
      const next = assignNearest(projected, centres);
      const settled = next.every((c, i) => c === assignment[i]) && iter > 0;
      assignment = next;
      centres = recomputeCentres(projected, assignment, centres, anchor);
      if (settled) break;
    }

    assignment = balance(projected, assignment, centres);
    centres = recomputeCentres(projected, assignment, centres, anchor);

    const inertia = totalInertia(projected, assignment, centres);
    if (!best || inertia < best.inertia) best = { assignment, inertia, centres };
  }

  const result = best!;
  return {
    assignment: result.assignment,
    centres: result.centres.map((c) => unproject(c, points[0].lat)),
  };
}

// --- projection --------------------------------------------------------------

type Point = { x: number; y: number };

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG = 111_320;

function projectAll(points: LatLng[]): Point[] {
  const lat0 = points[0].lat;
  return points.map((p) => project(p, lat0));
}

/** Equirectangular around the first point; city-scale distances stay metric. */
function project(p: LatLng, lat0: number): Point {
  return {
    x: p.lng * M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180),
    y: p.lat * M_PER_DEG_LAT,
  };
}

function unproject(p: Point, lat0: number): LatLng {
  return {
    lat: p.y / M_PER_DEG_LAT,
    lng: p.x / (M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180)),
  };
}

// --- k-means -----------------------------------------------------------------

function seedPlusPlus(points: Point[], k: number, rng: () => number): Point[] {
  const centres: Point[] = [points[Math.floor(rng() * points.length)]];
  while (centres.length < k) {
    const d2 = points.map((p) => Math.min(...centres.map((c) => sqDist(p, c))));
    const total = d2.reduce((a, b) => a + b, 0);
    if (total === 0) {
      centres.push(points[Math.floor(rng() * points.length)]);
      continue;
    }
    let target = rng() * total;
    let index = 0;
    while (index < points.length - 1 && (target -= d2[index]) > 0) index++;
    centres.push(points[index]);
  }
  return centres;
}

function assignNearest(points: Point[], centres: Point[]): number[] {
  return points.map((p) => {
    let bestIndex = 0;
    let bestDist = Infinity;
    centres.forEach((c, i) => {
      const d = sqDist(p, c);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    });
    return bestIndex;
  });
}

/**
 * A supplied basecamp pulls each day's centre toward it, so days start and end
 * nearer where the traveller sleeps without collapsing every cluster onto it.
 */
function recomputeCentres(
  points: Point[],
  assignment: number[],
  previous: Point[],
  anchor: Point | null,
): Point[] {
  return previous.map((prev, cluster) => {
    const members = points.filter((_, i) => assignment[i] === cluster);
    if (members.length === 0) return prev;
    const centre = {
      x: members.reduce((s, p) => s + p.x, 0) / members.length,
      y: members.reduce((s, p) => s + p.y, 0) / members.length,
    };
    if (!anchor) return centre;
    return {
      x: centre.x * (1 - BASECAMP_BIAS) + anchor.x * BASECAMP_BIAS,
      y: centre.y * (1 - BASECAMP_BIAS) + anchor.y * BASECAMP_BIAS,
    };
  });
}

/**
 * Plain k-means happily returns one cluster of fourteen and one of two, which
 * makes one exhausting day and one empty one. Cap each cluster at ceil(n/k) and
 * move the worst-fitting members of oversized clusters to the nearest cluster
 * with room.
 */
function balance(points: Point[], assignment: number[], centres: Point[]): number[] {
  const k = centres.length;
  const capacity = Math.ceil(points.length / k);
  const out = [...assignment];

  for (let pass = 0; pass < k * 2; pass++) {
    const counts = new Array<number>(k).fill(0);
    out.forEach((c) => counts[c]++);
    const over = counts.findIndex((c) => c > capacity);
    if (over === -1) break;

    const members = out
      .map((c, i) => ({ i, c }))
      .filter((m) => m.c === over)
      .sort((a, b) => sqDist(points[b.i], centres[over]) - sqDist(points[a.i], centres[over]));

    const movable = members.slice(0, counts[over] - capacity);
    for (const m of movable) {
      let target = -1;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        if (c === over || counts[c] >= capacity) continue;
        const d = sqDist(points[m.i], centres[c]);
        if (d < bestDist) {
          bestDist = d;
          target = c;
        }
      }
      if (target === -1) break;
      out[m.i] = target;
      counts[target]++;
      counts[over]--;
    }
  }
  return out;
}

function totalInertia(points: Point[], assignment: number[], centres: Point[]): number {
  return points.reduce((sum, p, i) => sum + sqDist(p, centres[assignment[i]]), 0);
}

function sqDist(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function meanOf(points: LatLng[]): LatLng {
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
  };
}

// --- deterministic randomness ------------------------------------------------

function seedFrom(points: LatLng[], salt: number): number {
  let h = 0x811c9dc5 ^ salt;
  for (const p of points) {
    h ^= Math.round(p.lat * 1e4) | 0;
    h = Math.imul(h, 0x01000193);
    h ^= Math.round(p.lng * 1e4) | 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
