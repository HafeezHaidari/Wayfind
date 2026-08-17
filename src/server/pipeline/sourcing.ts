import type { CityStay, OpeningHours, Preferences } from "../../shared/types.js";
import type { Category, CategoryKey } from "../../shared/categories.js";
import { CATEGORIES, CATEGORY_BY_KEY, categorise, categoriesForTags } from "../../shared/categories.js";
import { INTEREST_TAGS } from "../../shared/interests.js";
import type { LatLng } from "../../shared/geo.js";
import { env } from "../env.js";
import { debug, info } from "../log.js";
import type { Counters } from "./counters.js";
import { PoiCache } from "./cache.js";
import { coordsOf, osmId, queryOverpass, type OverpassElement, type OverpassResponse } from "./overpass.js";
import {
  fetchWikivoyageArticle,
  isVisitable,
  parseListings,
  type ListingKind,
  type WikivoyageListing,
} from "./wikivoyage.js";
import { fetchSitelinkCounts } from "./wikidata.js";
import { bestMatch, dedupeBy } from "./match.js";
import { hoursFromWikivoyage } from "./hours-from-text.js";
import { emptySignals, type Candidate, type RankingSignals } from "./candidates.js";
import { fixtureSlug, readFixture } from "./fixtures.js";

/**
 * §5b — the sourcing procedure, in the order the brief lays it out:
 *   1. Wikivoyage article for the city, listings extracted
 *   2. Overpass for the categories the traveller did not rule out
 *   3. match listings to OSM objects by name and proximity
 *   4. Wikidata sitelinks for matched entities
 *   5. deduplicate
 *
 * Every stage takes its input as an argument rather than fetching internally
 * (§11a), so the identical logic runs against fixtures or live data.
 */

export type SourcingResult = {
  candidates: Candidate[];
  /** Generation-level notes for the UI, e.g. thin editorial coverage (§12). */
  notes: string[];
};

/** §5e — process-lifetime, third-party data only, never keyed by anything user-specific. */
const cache = new PoiCache<Candidate[]>();

export function clearSourcingCache() {
  cache.clear();
}

/**
 * A city with fewer editorial listings than this has too thin a Wikivoyage
 * article to provide the quality signal §5a relies on. §12 says report the
 * degradation rather than substituting a paid source.
 */
const THIN_COVERAGE_LISTINGS = 12;

export async function sourceCity(
  city: CityStay,
  preferences: Preferences,
  counters: Counters,
): Promise<SourcingResult> {
  const categories = wantedCategories(preferences);
  const cacheKey = PoiCache.keyFor(city.cityName, categories.map((c) => c.key));
  const cached = cache.get(cacheKey, counters);
  if (cached) return { candidates: cached, notes: [] };

  const centre: LatLng = { lat: city.lat, lng: city.lng };

  const [article, overpass] = await Promise.all([
    fetchWikivoyageArticle(city.cityName, counters).catch((err) => {
      // Editorial signal is valuable but not load-bearing: OSM-only ranking is
      // worse, not broken. Report it rather than failing the generation (§12).
      info(`Wikivoyage lookup failed for ${city.cityName}: ${String(err)}`);
      return null;
    }),
    loadOverpass(centre, categories, city.cityName, counters),
  ]);

  const listings = article ? parseListings(article).filter(isVisitable) : [];
  const result = await assembleCandidates({
    city,
    centre,
    listings,
    overpass,
    categories,
    counters,
  });

  cache.set(cacheKey, result.candidates);
  return result;
}

async function loadOverpass(
  centre: LatLng,
  categories: Category[],
  cityName: string,
  counters: Counters,
): Promise<OverpassResponse> {
  if (env.fixtureMode) {
    counters.overpassQueries += 1;
    return readFixture<OverpassResponse>(fixtureSlug(cityName), "overpass.json");
  }
  return queryOverpass(centre, categories, counters);
}

/**
 * The pure half of sourcing: given raw source responses, produce candidates.
 * Exported so fixtures and live data run through exactly this code (§11c).
 */
export async function assembleCandidates(input: {
  city: CityStay;
  centre: LatLng;
  listings: WikivoyageListing[];
  overpass: OverpassResponse;
  categories: Category[];
  counters: Counters;
}): Promise<SourcingResult> {
  const { city, listings, overpass, categories, counters } = input;
  const notes: string[] = [];
  const wanted = new Set(categories.map((c) => c.key));

  // --- step 2: OSM objects into candidates ---------------------------------
  const osmCandidates: Candidate[] = [];
  for (const element of overpass.elements) {
    const candidate = candidateFromOsm(element, wanted);
    if (candidate) osmCandidates.push(candidate);
  }

  // --- step 3: match Wikivoyage listings to OSM objects ---------------------
  const matchTargets = osmCandidates.map((c) => ({
    name: c.poi.name,
    lat: c.poi.lat,
    lng: c.poi.lng,
    wikidata: c.poi.sourceIds.wikidata ?? null,
    candidate: c,
  }));

  const editorialOnly: Candidate[] = [];
  const total = listings.length;

  for (const listing of listings) {
    const match = bestMatch(
      { name: listing.name, lat: listing.lat, lng: listing.lng, wikidata: listing.wikidata },
      matchTargets,
    );
    if (match) {
      applyEditorialSignal(match.item.candidate, listing, total);
      if (listing.wikidata && !match.item.candidate.poi.sourceIds.wikidata) {
        match.item.candidate.poi.sourceIds.wikidata = listing.wikidata;
      }
      continue;
    }
    // A listing OSM did not return is still a real place a human wrote up. It
    // becomes a candidate in its own right when it has coordinates to plan with.
    const standalone = candidateFromListing(listing, total, wanted);
    if (standalone) editorialOnly.push(standalone);
  }

  // --- step 4: notability --------------------------------------------------
  const all = [...osmCandidates, ...editorialOnly];
  const wikidataIds = all
    .map((c) => c.poi.sourceIds.wikidata)
    .filter((id): id is string => typeof id === "string");
  const sitelinks = await fetchSitelinkCounts(wikidataIds, counters, city.cityName).catch(
    (err): Record<string, number> => {
      info(`Wikidata lookup failed for ${city.cityName}: ${String(err)}`);
      return {};
    },
  );
  for (const candidate of all) {
    const id = candidate.poi.sourceIds.wikidata;
    if (id && sitelinks[id]) candidate.signals.sitelinks = sitelinks[id];
  }

  // --- step 5: deduplicate -------------------------------------------------
  const deduped = dedupeCandidates(all);

  const listedCount = deduped.filter((c) => c.signals.editorialListed).length;
  if (total === 0) {
    notes.push(
      `No Wikivoyage article was found for ${city.cityName}, so places are ranked on OpenStreetMap ` +
        `data alone. Expect a weaker sense of what's actually worth seeing.`,
    );
  } else if (listedCount < THIN_COVERAGE_LISTINGS) {
    notes.push(
      `Wikivoyage's ${city.cityName} article lists only ${listedCount} places that could be matched, ` +
        `so the ranking leans more on OpenStreetMap than usual.`,
    );
  }

  debug(`sourced ${deduped.length} candidates for ${city.cityName}`, {
    osm: osmCandidates.length,
    editorialOnly: editorialOnly.length,
    listings: total,
    matched: listedCount,
  });

  return { candidates: deduped, notes };
}

// --- building candidates -----------------------------------------------------

function candidateFromOsm(element: OverpassElement, wanted: Set<CategoryKey>): Candidate | null {
  const tags = element.tags ?? {};
  const name = tags.name?.trim();
  if (!name) return null;
  const coords = coordsOf(element);
  if (!coords) return null;

  const category = categorise(tags);
  if (!category) return null;
  // `small-museum` is a refinement of `major-museum`, never fetched on its own.
  const gate = category.key === "small-museum" ? "major-museum" : category.key;
  if (!wanted.has(gate as CategoryKey) && !wanted.has(category.key)) return null;

  const signals = emptySignals();
  signals.wheelchair = tags.wheelchair ?? null;
  signals.kidFriendly = kidFriendlyFrom(tags);
  signals.feeFree = tags.fee === "no" ? true : tags.fee === "yes" ? false : null;

  return {
    poi: {
      id: osmId(element),
      name,
      lat: coords.lat,
      lng: coords.lng,
      tags: category.tags,
      category: category.key,
      sourceIds: { osm: osmId(element), wikidata: tags.wikidata },
      openingHours: openingHoursFromOsm(tags),
      typicalDurationMin: category.durationMin,
      priceTier: priceTierFromOsm(tags, category),
      score: 0,
      rationale: null,
      provenance: "osm",
    },
    signals,
  };
}

function candidateFromListing(
  listing: WikivoyageListing,
  total: number,
  wanted: Set<CategoryKey>,
): Candidate | null {
  if (listing.lat === null || listing.lng === null) return null;
  const category = categoryForListing(listing);
  const gate = category.key === "small-museum" ? "major-museum" : category.key;
  if (!wanted.has(gate as CategoryKey) && !wanted.has(category.key)) return null;

  const signals = emptySignals();
  signals.editorialOnly = true;

  const candidate: Candidate = {
    poi: {
      id: `wikivoyage/${slugForListing(listing)}`,
      name: listing.name,
      lat: listing.lat,
      lng: listing.lng,
      tags: category.tags,
      category: category.key,
      sourceIds: { wikivoyage: listing.name, wikidata: listing.wikidata ?? undefined },
      openingHours: hoursFromWikivoyage(listing.hours),
      typicalDurationMin: refineDuration(category.durationMin, listing.content),
      priceTier: priceTierFromText(listing.price, category),
      score: 0,
      rationale: null,
      provenance: "wikivoyage",
    },
    signals,
  };
  applyEditorialSignal(candidate, listing, total);
  return candidate;
}

function applyEditorialSignal(candidate: Candidate, listing: WikivoyageListing, total: number) {
  const s = candidate.signals;
  // A place listed twice keeps its most prominent appearance.
  if (s.editorialListed && s.editorialOrder !== null && s.editorialOrder <= listing.order) return;
  s.editorialListed = true;
  s.editorialKind = listing.kind;
  s.editorialOrder = listing.order;
  s.editorialTotal = total;
  s.editorialContentLength = listing.content.length;

  // Editorial hours only fill a gap; an OSM tag is the better source (§5a).
  if (!candidate.poi.openingHours) {
    const fromText = hoursFromWikivoyage(listing.hours);
    if (fromText) candidate.poi.openingHours = fromText;
  }
  // §5c: refine duration from Wikivoyage text where it says something useful.
  candidate.poi.typicalDurationMin = refineDuration(
    candidate.poi.typicalDurationMin,
    listing.content,
  );
}

/** Keep the richer of two records for the same place (§5b step 5). */
function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const matchable = candidates.map((c) => ({
    name: c.poi.name,
    lat: c.poi.lat,
    lng: c.poi.lng,
    wikidata: c.poi.sourceIds.wikidata ?? null,
    candidate: c,
  }));

  const kept = dedupeBy(matchable, (a, b) => {
    const merged = mergeCandidates(a.candidate, b.candidate);
    return { ...a, candidate: merged, wikidata: merged.poi.sourceIds.wikidata ?? null };
  });
  return kept.map((k) => k.candidate);
}

function mergeCandidates(a: Candidate, b: Candidate): Candidate {
  // Prefer the OSM record as the spine — it has the structured hours — but take
  // whatever the other one knows that it does not.
  const [primary, secondary] = a.poi.provenance === "osm" ? [a, b] : [b, a];
  primary.poi.openingHours = primary.poi.openingHours ?? secondary.poi.openingHours;
  primary.poi.sourceIds = {
    ...secondary.poi.sourceIds,
    ...Object.fromEntries(Object.entries(primary.poi.sourceIds).filter(([, v]) => v)),
  };
  primary.poi.priceTier = primary.poi.priceTier ?? secondary.poi.priceTier;
  primary.poi.typicalDurationMin = Math.max(
    primary.poi.typicalDurationMin,
    secondary.poi.typicalDurationMin,
  );
  primary.poi.tags = [...new Set([...primary.poi.tags, ...secondary.poi.tags])];
  primary.signals = mergeSignals(primary.signals, secondary.signals);
  return primary;
}

function mergeSignals(a: RankingSignals, b: RankingSignals): RankingSignals {
  return {
    editorialListed: a.editorialListed || b.editorialListed,
    editorialKind: a.editorialKind ?? b.editorialKind,
    editorialOrder:
      a.editorialOrder === null
        ? b.editorialOrder
        : b.editorialOrder === null
          ? a.editorialOrder
          : Math.min(a.editorialOrder, b.editorialOrder),
    editorialTotal: Math.max(a.editorialTotal, b.editorialTotal),
    editorialContentLength: Math.max(a.editorialContentLength, b.editorialContentLength),
    sitelinks: Math.max(a.sitelinks, b.sitelinks),
    wheelchair: a.wheelchair ?? b.wheelchair,
    kidFriendly: a.kidFriendly ?? b.kidFriendly,
    feeFree: a.feeFree ?? b.feeFree,
    editorialOnly: a.editorialOnly && b.editorialOnly,
  };
}

// --- field derivation --------------------------------------------------------

export function wantedCategories(preferences: Preferences): Category[] {
  // §5b step 2: do not fetch categories the traveller marked "avoid". That is
  // both wasted bandwidth and a smaller, better candidate set to rank.
  const tags = INTEREST_TAGS.filter((tag) => (preferences.interests[tag] ?? 1) > 0);
  const categories = categoriesForTags(tags);

  // Meals happen whether or not food is an interest (§7b), so the venues to
  // fill them with are always worth fetching.
  const mealKeys: CategoryKey[] = ["restaurant", "cafe"];
  for (const key of mealKeys) {
    if (!categories.some((c) => c.key === key)) categories.push(CATEGORY_BY_KEY[key]);
  }
  return categories;
}

function openingHoursFromOsm(tags: Record<string, string>): OpeningHours | null {
  const raw = tags.opening_hours?.trim();
  return raw ? { raw, source: "osm" } : null;
}

function kidFriendlyFrom(tags: Record<string, string>): boolean | null {
  if (tags["kids_area"] === "yes" || tags["playground"] === "yes") return true;
  if (tags["min_age"]) return false;
  return null;
}

function priceTierFromOsm(tags: Record<string, string>, category: Category): 0 | 1 | 2 | 3 | null {
  if (tags.fee === "no") return 0;
  const charge = tags.charge ?? tags["fee:amount"];
  if (charge) {
    const amount = Number(charge.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(amount)) return tierFromAmount(amount);
  }
  return category.defaultPriceTier;
}

function priceTierFromText(price: string | null, category: Category): 0 | 1 | 2 | 3 | null {
  if (!price) return category.defaultPriceTier;
  if (/free|gratis|grátis|no charge/i.test(price)) return 0;
  const amount = Number(price.replace(/[^0-9.]/g, "").slice(0, 6));
  if (Number.isFinite(amount) && amount > 0) return tierFromAmount(amount);
  return category.defaultPriceTier;
}

function tierFromAmount(amount: number): 0 | 1 | 2 | 3 {
  if (amount <= 0) return 0;
  if (amount < 8) return 1;
  if (amount < 20) return 2;
  return 3;
}

/**
 * §5c — refine a category's default duration where Wikivoyage says something
 * useful. Only explicit statements count; "you could spend hours here" is
 * enthusiasm, not a schedule.
 */
export function refineDuration(base: number, text: string): number {
  if (!text) return base;
  const halfDay = /\b(half[- ]a?[- ]?day|half day)\b/i.test(text);
  if (halfDay) return Math.max(base, 210);
  const fullDay = /\b(a full day|whole day|all day)\b/i.test(text);
  if (fullDay) return Math.max(base, 300);

  const explicit = text.match(
    /\b(?:allow|takes?|needs?|requires?|budget|set aside|reckon on)\b[^.]{0,40}?(\d+(?:\.\d+)?)\s*(hour|hours|hr|hrs|minute|minutes|min)\b/i,
  );
  if (explicit) {
    const value = Number(explicit[1]);
    const minutes = /^h/i.test(explicit[2]) ? value * 60 : value;
    if (minutes >= 15 && minutes <= 480) return Math.round(minutes);
  }
  return base;
}

/**
 * Wikivoyage listings with no OSM counterpart still need a category for their
 * duration and interest tags. Infer it from the name, which usually says what
 * the place is, and fall back to the listing kind.
 */
export function categoryForListing(listing: WikivoyageListing): Category {
  const haystack = `${listing.name} ${listing.alt ?? ""}`.toLowerCase();
  for (const [pattern, key] of NAME_HINTS) {
    if (pattern.test(haystack)) return CATEGORY_BY_KEY[key];
  }
  return CATEGORY_BY_KEY[KIND_DEFAULT[listing.kind]];
}

/** Multilingual because place names are, and the article is about a real city. */
const NAME_HINTS: [RegExp, CategoryKey][] = [
  [/\b(museu|museum|museo|musée|musee)\b/, "major-museum"],
  [/\b(galeria|gallery|galerie)\b/, "gallery"],
  [/\b(igreja|church|iglesia|église|eglise|sé|catedral|cathedral|duomo|capela|chapel|mosteiro|monastery|abbey)\b/, "church"],
  [/\b(palácio|palacio|palace|palais|castelo|castle|forte|fortress|château|chateau)\b/, "castle"],
  [/\b(jardim|jardins|garden|gardens|jardín|jardin)\b/, "garden"],
  [/\b(parque|park|parc)\b/, "park"],
  [/\b(miradouro|viewpoint|mirador|belvedere|lookout)\b/, "viewpoint"],
  [/\b(mercado|market|marché|marche|markt)\b/, "market"],
  [/\b(ponte|bridge|pont|puente)\b/, "bridge"],
  [/\b(praia|beach|playa|plage)\b/, "beach"],
  [/\b(teatro|theatre|theater|opera|ópera)\b/, "theatre"],
  [/\b(zoo|aquarium|aquário|aquario)\b/, "zoo-aquarium"],
  [/\b(livraria|bookshop|bookstore)\b/, "shop"],
  [/\b(est[aá]dio|stadium|arena|cruise|cruzeiro|tour|walking tour|workshop|class)\b/, "activity"],
];

const KIND_DEFAULT: Record<ListingKind, CategoryKey> = {
  see: "monument",
  do: "activity",
  eat: "restaurant",
  drink: "bar",
  buy: "shop",
  sleep: "monument", // filtered out before this point
  other: "monument",
};

function slugForListing(listing: WikivoyageListing): string {
  return `${listing.name}-${listing.lat?.toFixed(4)}-${listing.lng?.toFixed(4)}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-|-$/g, "");
}

export { CATEGORIES };
