import type { CityStay, OpeningHours, Poi, TravelMatrix } from "../../src/shared/types.js";
import type { CategoryKey } from "../../src/shared/categories.js";
import { CATEGORY_BY_KEY } from "../../src/shared/categories.js";
import { walkingDistanceM } from "../../src/shared/geo.js";
import { estimateMinutes, key } from "../../src/core/travel.js";

/**
 * Synthetic POIs and a synthetic travel matrix. §11a: the scheduler needs no
 * fixtures at all — it is a pure function and gets real unit tests over made-up
 * data. Nothing here stands in for the real pipeline; it only feeds the pure
 * function its arguments.
 */

export const PORTO_CENTRE = { lat: 41.1496, lng: -8.6109 };

let counter = 0;

export function poi(overrides: Partial<Poi> & { name?: string } = {}): Poi {
  counter += 1;
  const category: CategoryKey = overrides.category ?? "monument";
  const cat = CATEGORY_BY_KEY[category];
  return {
    id: overrides.id ?? `poi-${counter}`,
    name: overrides.name ?? `Place ${counter}`,
    lat: overrides.lat ?? PORTO_CENTRE.lat,
    lng: overrides.lng ?? PORTO_CENTRE.lng,
    tags: overrides.tags ?? cat.tags,
    category,
    sourceIds: overrides.sourceIds ?? { osm: `node/${counter}` },
    openingHours: overrides.openingHours ?? null,
    typicalDurationMin: overrides.typicalDurationMin ?? cat.durationMin,
    priceTier: overrides.priceTier ?? cat.defaultPriceTier,
    score: overrides.score ?? 1,
    rationale: overrides.rationale ?? null,
    provenance: overrides.provenance ?? "osm",
  };
}

export function hours(raw: string): OpeningHours {
  return { raw, source: "osm" };
}

/**
 * A ring of POIs at a given radius around the centre — enough geographic
 * spread for clustering to have something to do, and predictable distances.
 */
export function ringOfPois(
  count: number,
  radiusM: number,
  overrides: (i: number) => Partial<Poi> = () => ({}),
): Poi[] {
  const out: Poi[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const dLat = (radiusM * Math.cos(angle)) / 110_540;
    const dLng =
      (radiusM * Math.sin(angle)) / (111_320 * Math.cos((PORTO_CENTRE.lat * Math.PI) / 180));
    out.push(
      poi({
        lat: PORTO_CENTRE.lat + dLat,
        lng: PORTO_CENTRE.lng + dLng,
        name: `Ring place ${i + 1}`,
        ...overrides(i),
      }),
    );
  }
  return out;
}

/** Several tight clusters, the shape a real city's POIs actually take. */
export function clusteredPois(
  clusters: number,
  perCluster: number,
  spreadM = 300,
  separationM = 2500,
  overrides: (clusterIndex: number, i: number) => Partial<Poi> = () => ({}),
): Poi[] {
  const out: Poi[] = [];
  for (let c = 0; c < clusters; c++) {
    const angle = (c / clusters) * Math.PI * 2;
    const cLat = PORTO_CENTRE.lat + (separationM * Math.cos(angle)) / 110_540;
    const cLng =
      PORTO_CENTRE.lng +
      (separationM * Math.sin(angle)) / (111_320 * Math.cos((PORTO_CENTRE.lat * Math.PI) / 180));
    for (let i = 0; i < perCluster; i++) {
      const a = (i / perCluster) * Math.PI * 2;
      out.push(
        poi({
          lat: cLat + (spreadM * Math.cos(a)) / 110_540,
          lng: cLng + (spreadM * Math.sin(a)) / (111_320 * Math.cos((cLat * Math.PI) / 180)),
          name: `Cluster ${c + 1} place ${i + 1}`,
          ...overrides(c, i),
        }),
      );
    }
  }
  return out;
}

/** A travel matrix derived from straight-line distance — the same shape OSRM returns. */
export function syntheticMatrix(
  pois: Poi[],
  mode: TravelMatrix["mode"] = "walk",
  basecamp: { lat: number; lng: number } | null = null,
): TravelMatrix {
  const nodes: { id: string; lat: number; lng: number }[] = pois.map((p) => ({
    id: p.id,
    lat: p.lat,
    lng: p.lng,
  }));
  if (basecamp) nodes.push({ id: "basecamp", ...basecamp });

  const durations: Record<string, number> = {};
  const distances: Record<string, number> = {};
  for (const a of nodes) {
    for (const b of nodes) {
      if (a.id === b.id) continue;
      const metres = walkingDistanceM(a, b);
      distances[key(a.id, b.id)] = metres;
      durations[key(a.id, b.id)] = estimateMinutes(metres, mode);
    }
  }
  return { mode, approximate: mode !== "walk", durations, distances };
}

export function cityStay(overrides: Partial<CityStay> = {}): CityStay {
  return {
    cityName: "Porto",
    lat: PORTO_CENTRE.lat,
    lng: PORTO_CENTRE.lng,
    startDate: null,
    days: 2,
    basecampLat: null,
    basecampLng: null,
    ...overrides,
  };
}
