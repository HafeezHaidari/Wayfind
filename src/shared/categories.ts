/**
 * The category catalogue: the single place where an OSM object becomes a
 * Wayfind POI with interest tags, a typical duration (§5c) and a price hint.
 *
 * §5c is explicit that duration defaults are load-bearing and must live in one
 * file rather than being scattered through the scheduler. Everything a category
 * implies lives here, including the Overpass selectors used to fetch it, so
 * that adding a category is a single-file change.
 */

import type { InterestTag } from "./types.js";

export type CategoryKey =
  | "major-museum"
  | "small-museum"
  | "gallery"
  | "monument"
  | "castle"
  | "archaeological-site"
  | "viewpoint"
  | "park"
  | "garden"
  | "nature-reserve"
  | "beach"
  | "cafe"
  | "restaurant"
  | "bar"
  | "live-music-venue"
  | "market"
  | "church"
  | "shrine"
  | "neighbourhood"
  | "shop"
  | "bridge"
  | "theatre"
  | "street-art"
  | "zoo-aquarium";

export type Category = {
  key: CategoryKey;
  /** Traveller-facing category name shown on a stop block (§9c). */
  label: string;
  /** Interest tags a POI in this category satisfies. */
  tags: InterestTag[];
  /** §5c duration defaults, in minutes. */
  durationMin: number;
  /** Below this, a visit is not worth making; the scheduler will not shrink past it (§7d). */
  minDurationMin: number;
  /** Price tier when the source gives no better signal. */
  defaultPriceTier: 0 | 1 | 2 | 3 | null;
  /** Overpass selectors, e.g. `["tourism"="museum"]`. Any match assigns the category. */
  overpass: string[];
  /** Categories that are meal venues, used by §7b. */
  meal?: "lunch" | "dinner" | "either";
  /** Roughly how kid-friendly, -1 discourage / 0 neutral / 1 encourage (§6a group fit). */
  kidFit: -1 | 0 | 1;
  /** Typically indoor. Used for nothing yet but recorded where it is known. */
  indoor: boolean;
};

/**
 * Order matters: the first matching category wins in `categorise`, so more
 * specific selectors must precede general ones.
 */
export const CATEGORIES: Category[] = [
  {
    key: "major-museum",
    label: "Museum",
    tags: ["museums", "history", "art"],
    durationMin: 120,
    minDurationMin: 60,
    defaultPriceTier: 2,
    overpass: ['["tourism"="museum"]'],
    kidFit: 0,
    indoor: true,
  },
  {
    key: "small-museum",
    label: "Small museum",
    tags: ["museums", "history"],
    durationMin: 60,
    minDurationMin: 30,
    defaultPriceTier: 1,
    // Assigned by refinement in `categorise`, never fetched separately.
    overpass: [],
    kidFit: 0,
    indoor: true,
  },
  {
    key: "gallery",
    label: "Gallery",
    tags: ["art", "museums"],
    durationMin: 60,
    minDurationMin: 30,
    defaultPriceTier: 1,
    overpass: ['["tourism"="gallery"]'],
    kidFit: -1,
    indoor: true,
  },
  {
    key: "castle",
    label: "Castle or palace",
    tags: ["history", "architecture"],
    durationMin: 90,
    minDurationMin: 45,
    defaultPriceTier: 2,
    overpass: ['["historic"="castle"]', '["historic"="palace"]', '["historic"="fort"]'],
    kidFit: 1,
    indoor: true,
  },
  {
    key: "archaeological-site",
    label: "Archaeological site",
    tags: ["history", "offbeat"],
    durationMin: 75,
    minDurationMin: 40,
    defaultPriceTier: 1,
    overpass: ['["historic"="archaeological_site"]', '["historic"="ruins"]'],
    kidFit: 0,
    indoor: false,
  },
  {
    key: "monument",
    label: "Monument",
    tags: ["history", "architecture", "photography"],
    durationMin: 30,
    minDurationMin: 15,
    defaultPriceTier: 0,
    overpass: ['["historic"="monument"]', '["historic"="memorial"]', '["tourism"="attraction"]'],
    kidFit: 0,
    indoor: false,
  },
  {
    key: "bridge",
    label: "Bridge",
    tags: ["architecture", "photography", "viewpoints"],
    durationMin: 30,
    minDurationMin: 15,
    defaultPriceTier: 0,
    overpass: ['["man_made"="bridge"]'],
    kidFit: 0,
    indoor: false,
  },
  {
    key: "viewpoint",
    label: "Viewpoint",
    tags: ["viewpoints", "photography", "nature"],
    durationMin: 30,
    minDurationMin: 15,
    defaultPriceTier: 0,
    overpass: ['["tourism"="viewpoint"]'],
    kidFit: 1,
    indoor: false,
  },
  {
    key: "park",
    label: "Park",
    tags: ["parks", "nature"],
    durationMin: 45,
    minDurationMin: 25,
    defaultPriceTier: 0,
    overpass: ['["leisure"="park"]'],
    kidFit: 1,
    indoor: false,
  },
  {
    key: "garden",
    label: "Garden",
    tags: ["parks", "nature", "photography"],
    durationMin: 60,
    minDurationMin: 30,
    defaultPriceTier: 1,
    overpass: ['["leisure"="garden"]["garden:type"="botanical"]', '["tourism"="garden"]'],
    kidFit: 0,
    indoor: false,
  },
  {
    key: "nature-reserve",
    label: "Nature reserve",
    tags: ["nature", "parks"],
    durationMin: 90,
    minDurationMin: 45,
    defaultPriceTier: 0,
    overpass: ['["leisure"="nature_reserve"]'],
    kidFit: 0,
    indoor: false,
  },
  {
    key: "beach",
    label: "Beach",
    tags: ["beaches", "nature"],
    durationMin: 90,
    minDurationMin: 45,
    defaultPriceTier: 0,
    overpass: ['["natural"="beach"]'],
    kidFit: 1,
    indoor: false,
  },
  {
    key: "zoo-aquarium",
    label: "Zoo or aquarium",
    tags: ["nature", "offbeat"],
    durationMin: 120,
    minDurationMin: 60,
    defaultPriceTier: 2,
    overpass: ['["tourism"="zoo"]', '["tourism"="aquarium"]'],
    kidFit: 1,
    indoor: false,
  },
  {
    key: "cafe",
    label: "Café",
    tags: ["cafes", "food"],
    durationMin: 45,
    minDurationMin: 25,
    defaultPriceTier: 1,
    overpass: ['["amenity"="cafe"]'],
    meal: "lunch",
    kidFit: 0,
    indoor: true,
  },
  {
    key: "restaurant",
    label: "Restaurant",
    tags: ["food"],
    durationMin: 90,
    minDurationMin: 45,
    defaultPriceTier: 2,
    overpass: ['["amenity"="restaurant"]'],
    meal: "either",
    kidFit: 0,
    indoor: true,
  },
  {
    key: "bar",
    label: "Bar",
    tags: ["nightlife"],
    durationMin: 75,
    minDurationMin: 40,
    defaultPriceTier: 2,
    overpass: ['["amenity"="bar"]', '["amenity"="pub"]'],
    kidFit: -1,
    indoor: true,
  },
  {
    key: "live-music-venue",
    label: "Live music",
    tags: ["live-music", "nightlife"],
    durationMin: 120,
    minDurationMin: 60,
    defaultPriceTier: 2,
    overpass: ['["amenity"="nightclub"]', '["amenity"="music_venue"]'],
    kidFit: -1,
    indoor: true,
  },
  {
    key: "theatre",
    label: "Theatre",
    tags: ["live-music", "architecture", "art"],
    durationMin: 120,
    minDurationMin: 60,
    defaultPriceTier: 2,
    overpass: ['["amenity"="theatre"]'],
    kidFit: 0,
    indoor: true,
  },
  {
    key: "market",
    label: "Market",
    tags: ["markets", "food", "shopping"],
    durationMin: 60,
    minDurationMin: 30,
    defaultPriceTier: 1,
    overpass: ['["amenity"="marketplace"]', '["shop"="market"]'],
    meal: "lunch",
    kidFit: 1,
    indoor: false,
  },
  {
    key: "church",
    label: "Church",
    tags: ["religious-sites", "architecture", "history"],
    durationMin: 30,
    minDurationMin: 15,
    defaultPriceTier: 0,
    overpass: ['["building"="cathedral"]', '["amenity"="place_of_worship"]'],
    kidFit: -1,
    indoor: true,
  },
  {
    key: "shrine",
    label: "Shrine",
    tags: ["religious-sites", "offbeat"],
    durationMin: 20,
    minDurationMin: 15,
    defaultPriceTier: 0,
    overpass: ['["historic"="wayside_shrine"]'],
    kidFit: -1,
    indoor: false,
  },
  {
    key: "neighbourhood",
    label: "Neighbourhood",
    tags: ["neighbourhoods", "photography", "architecture"],
    durationMin: 90,
    minDurationMin: 45,
    defaultPriceTier: 0,
    overpass: ['["place"="neighbourhood"]', '["place"="quarter"]'],
    kidFit: 0,
    indoor: false,
  },
  {
    key: "street-art",
    label: "Street art",
    tags: ["art", "offbeat", "photography"],
    durationMin: 30,
    minDurationMin: 15,
    defaultPriceTier: 0,
    overpass: ['["tourism"="artwork"]'],
    kidFit: 0,
    indoor: false,
  },
  {
    key: "shop",
    label: "Shopping",
    tags: ["shopping"],
    durationMin: 45,
    minDurationMin: 25,
    defaultPriceTier: 2,
    overpass: ['["shop"="department_store"]', '["shop"="mall"]', '["shop"="books"]'],
    kidFit: 0,
    indoor: true,
  },
];

export const CATEGORY_BY_KEY: Record<CategoryKey, Category> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c]),
) as Record<CategoryKey, Category>;

/** Which categories are worth fetching for a given interest tag. */
export function categoriesForTags(tags: InterestTag[]): Category[] {
  const wanted = new Set(tags);
  return CATEGORIES.filter((c) => c.overpass.length > 0 && c.tags.some((t) => wanted.has(t)));
}

/**
 * Assign a category to a raw OSM tag bag. Returns null when nothing matches,
 * which means the object is not a candidate at all.
 *
 * Refinements beyond the plain selector list live here: a `tourism=museum` with
 * no Wikidata link and no name qualifier is more likely a one-room local museum
 * than a 2-hour institution, and scheduling it as 120 minutes wastes a day.
 */
export function categorise(osmTags: Record<string, string>): Category | null {
  for (const category of CATEGORIES) {
    if (category.overpass.length === 0) continue;
    if (matchesAnySelector(osmTags, category.overpass)) {
      if (category.key === "major-museum" && !looksMajor(osmTags)) {
        return CATEGORY_BY_KEY["small-museum"];
      }
      return category;
    }
  }
  return null;
}

function looksMajor(osmTags: Record<string, string>): boolean {
  // A Wikidata link or a Wikipedia article is the cheapest available proxy for
  // an institution large enough to justify a two-hour default.
  return Boolean(osmTags["wikidata"] || osmTags["wikipedia"]);
}

function matchesAnySelector(osmTags: Record<string, string>, selectors: string[]): boolean {
  return selectors.some((selector) => parseSelector(selector).every(([k, v]) => osmTags[k] === v));
}

/** `["tourism"="museum"]["x"="y"]` -> [["tourism","museum"],["x","y"]] */
function parseSelector(selector: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /\["([^"]+)"="([^"]+)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(selector)) !== null) out.push([m[1], m[2]]);
  return out;
}
