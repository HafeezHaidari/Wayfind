import type { Category } from "../../shared/categories.js";
import { bboxAround, type LatLng } from "../../shared/geo.js";
import { env, USER_AGENT } from "../env.js";
import { fetchJson } from "./http.js";
import type { Counters } from "./counters.js";
import { info } from "../log.js";
import { overpassLimiter } from "./limiter.js";

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

/**
 * Half-width of the box searched around the city centre.
 *
 * 4 km is not a performance hack dressed up as a product decision: the daily
 * walking caps in §7d top out at 12 km *in total*, so a place 6 km from the
 * centre was never going to be scheduled anyway. Shrinking the box more than
 * halves the area Overpass has to scan, which in Tokyo is the difference
 * between a usable query and one that exceeds three minutes.
 */
const SIGHT_RADIUS_M = 4000;
/** Food is denser still, and meals sit between central stops. */
const FOOD_RADIUS_M = 2000;

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
      .map((selector) => `${category.elements}${selector}[name]${box ? `(${box})` : ""};`)
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

/**
 * §10 — "Overpass is a free shared service. Respect it."
 *
 * Overpass publishes its own rate-limit state at `/api/status`, including the
 * exact moment your next slot frees up:
 *
 *   Rate limit: 2
 *   1 slots available now.
 *   Slot available after: 2026-08-18T08:50:44Z, in 2 seconds.
 *
 * Measured, the limit is not about query cost — a heavy Tokyo query succeeded
 * in 20s and a lighter Kyoto one seconds later was refused outright. Firing and
 * hoping produces a 504, and the retry then burns another slot. So ask first
 * and wait the stated time. The status endpoint itself does not consume a slot.
 *
 * Fails soft: if the status cannot be read or parsed, the query goes ahead.
 */
async function waitForSlot(endpoint: string): Promise<void> {
  const statusUrl = endpoint.replace(/\/interpreter\/?$/, "/status");
  if (statusUrl === endpoint) return; // a self-hosted URL we don't recognise

  let report: string;
  try {
    const res = await fetch(statusUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return;
    report = await res.text();
  } catch {
    return;
  }

  const available = Number(report.match(/(\d+)\s+slots? available now/)?.[1] ?? "1");
  if (available > 0) return;

  const seconds = Number(report.match(/in\s+(\d+)\s+seconds?/)?.[1] ?? "0");
  const wait = Math.min(Math.max(seconds, 1) + 1, MAX_SLOT_WAIT_S);
  info(`Overpass has no free slot; waiting ${wait}s for one`);
  await new Promise((resolve) => setTimeout(resolve, wait * 1000));
}

/** Beyond this we stop waiting and let the request fail with a clear message. */
const MAX_SLOT_WAIT_S = 90;

/**
 * Remember which endpoints are sick, so a multi-city trip pays the cost of a
 * dead host once rather than once per city. Without this, three cities meant
 * three separate waits on the same unresponsive primary and a nine-day trip
 * took over ten minutes.
 */
const unhealthyUntil = new Map<string, number>();
const UNHEALTHY_FOR_MS = 5 * 60_000;

/** Healthy endpoints first, recently-failed ones last but never excluded. */
function orderedEndpoints(): string[] {
  const all = [env.overpassUrl, ...env.overpassFallbackUrls];
  const now = Date.now();
  const healthy = all.filter((url) => (unhealthyUntil.get(url) ?? 0) <= now);
  const resting = all.filter((url) => (unhealthyUntil.get(url) ?? 0) > now);
  return [...healthy, ...resting];
}

export async function queryOverpass(
  centre: LatLng,
  categories: Category[],
  counters: Counters,
): Promise<OverpassResponse> {
  const query = buildQuery(centre, categories);
  counters.overpassQueries += 1;
  const body = new URLSearchParams({ data: query });
  // §10 — never more than one in flight, whatever the caller is doing, and
  // never before Overpass says it has a slot for us.
  const endpoints = orderedEndpoints();
  let lastError: unknown = null;

  return overpassLimiter.run(async () => {
    for (const [index, endpoint] of endpoints.entries()) {
      try {
        await waitForSlot(endpoint);
        const response = await fetchJson<OverpassResponse>(endpoint, {
          body,
          label: "Overpass",
          timeoutMs: 200_000,
          // With somewhere else to go, move on rather than hammering a sick host.
          retries: index === endpoints.length - 1 ? 2 : 1,
        });

        // Overpass reports a server-side timeout as HTTP 200 with an empty
        // element list and a `remark`. Treating that as "no places here" would
        // be exactly the empty success §11c forbids, so it fails loudly.
        if (response.remark && /error|timed out|timeout/i.test(response.remark)) {
          throw new Error(`Overpass couldn't complete the query: ${response.remark}`);
        }
        unhealthyUntil.delete(endpoint);
        if (index > 0) info(`Overpass: served by ${hostOf(endpoint)}`);
        return response;
      } catch (err) {
        lastError = err;
        unhealthyUntil.set(endpoint, Date.now() + UNHEALTHY_FOR_MS);
        if (index < endpoints.length - 1) {
          info(
            `Overpass: ${hostOf(endpoint)} is not answering — trying ` +
              `${hostOf(endpoints[index + 1])}, and resting it for 5 minutes`,
          );
        }
      }
    }
    throw lastError ?? new Error("Overpass is unavailable");
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
