import type { Category } from "../../shared/categories.js";
import { bboxAround, type LatLng } from "../../shared/geo.js";
import { env } from "../env.js";
import { fetchJson } from "./http.js";
import type { Counters } from "./counters.js";

/**
 * §5a — OpenStreetMap via Overpass: free, keyless, global, and the only free
 * source that carries `opening_hours`. Weak on quality signal, which is what
 * Wikivoyage and Wikidata are for.
 *
 * §10 — one query per city per generation, all categories batched into it.
 * Per-category output limits keep a city's four hundred cafés from crowding out
 * its museums in the response.
 */

export type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

export type OverpassResponse = { elements: OverpassElement[]; remark?: string };

/** Half-width of the box searched around the city centre, per category group. */
const SIGHT_RADIUS_M = 6000;
/** Food is dense and local; a smaller box keeps the response honest in size. */
const FOOD_RADIUS_M = 3500;

const FOOD_CATEGORIES = new Set(["restaurant", "cafe", "bar"]);

/**
 * One Overpass QL query covering every wanted category (§10: one query per city
 * per generation, categories batched).
 *
 * Two structural decisions here were both bought with measurements against
 * Porto, and both matter more than they look:
 *
 * 1. The spatial filter is a global `[bbox:]`, not a per-selector `(around:)`.
 *    With `around`, the full category set took 93 seconds and timed out; with a
 *    bbox the same query returned in 7. `around` computes a true radius per
 *    selector, the bbox hits the spatial index once.
 *
 * 2. Every category gets its own named set and its own `out` limit. Pooling
 *    them into one set with one limit truncates arbitrarily — Porto returned
 *    480 objects that included neither Livraria Lello nor Igreja de São
 *    Francisco, because a few hundred artwork nodes had crowded them out. Per
 *    category, the same query returns 762 objects and the landmarks are there.
 *
 * It is still one HTTP request, which is what §10 asks for.
 */
export function buildQuery(centre: LatLng, categories: Category[]): string {
  const sightBox = boxLiteral(centre, SIGHT_RADIUS_M);
  const foodBox = boxLiteral(centre, FOOD_RADIUS_M);
  const usable = categories.filter((c) => c.overpass.length > 0);

  const lines = [`[out:json][timeout:180][bbox:${sightBox}];`];
  const outs: string[] = [];

  usable.forEach((category, index) => {
    const isFood = FOOD_CATEGORIES.has(category.key);
    const box = isFood ? foodBox : null;
    const set = `s${index}`;
    const selectors = category.overpass
      // `[name]` alone removes most of the untagged noise: an unnamed bench-like
      // node is never somewhere to schedule a visit to.
      .map((selector) => `nwr${selector}[name]${box ? `(${box})` : ""};`)
      .join(" ");
    lines.push(`(${selectors})->.${set};`);
    outs.push(`.${set} out center tags ${category.fetchLimit};`);
  });

  return [...lines, ...outs].join("\n");
}

/** Overpass wants `south,west,north,east`. */
function boxLiteral(centre: LatLng, radiusM: number): string {
  const box = bboxAround(centre, radiusM);
  return [box.south, box.west, box.north, box.east].map((v) => v.toFixed(4)).join(",");
}

export async function queryOverpass(
  centre: LatLng,
  categories: Category[],
  counters: Counters,
): Promise<OverpassResponse> {
  const query = buildQuery(centre, categories);
  counters.overpassQueries += 1;
  const body = new URLSearchParams({ data: query });
  const response = await fetchJson<OverpassResponse>(env.overpassUrl, {
    body,
    label: "Overpass",
    timeoutMs: 200_000,
  });

  // Overpass reports a server-side timeout as HTTP 200 with an empty element
  // list and a `remark`. Treating that as "no places here" would be exactly the
  // empty success §11c forbids, so it fails loudly instead.
  if (response.remark && /error|timed out|timeout/i.test(response.remark)) {
    throw new Error(`Overpass couldn't complete the query: ${response.remark}`);
  }
  return response;
}

/** Nodes carry coordinates directly; ways and relations carry a computed centre. */
export function coordsOf(element: OverpassElement): LatLng | null {
  if (typeof element.lat === "number" && typeof element.lon === "number") {
    return { lat: element.lat, lng: element.lon };
  }
  if (element.center) return { lat: element.center.lat, lng: element.center.lon };
  return null;
}

export function osmId(element: OverpassElement): string {
  return `${element.type}/${element.id}`;
}
