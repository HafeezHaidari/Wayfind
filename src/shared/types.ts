// The data model of §3, defined once and shared by client and server.
// TripBrief and the resulting itinerary live entirely in client state; the
// server never stores either (§1).

import type { CategoryKey } from "./categories.js";

export type TripBrief = {
  id: string;
  name: string;
  cities: CityStay[];
  preferences: Preferences;
  freeText: string | null; // unstructured extras from the interview
};

export type CityStay = {
  cityName: string;
  lat: number;
  lng: number; // city centroid, from geocoder
  startDate: string | null; // ISO date; null if the user gave only a day count
  days: number;
  basecampLat: number | null; // hotel/accommodation if the user supplied one
  basecampLng: number | null;
  /**
   * ISO 3166-1 alpha-2, from the geocoder. An addition to the §3 model with a
   * concrete cause: OSM `opening_hours` values routinely carry `PH` (public
   * holiday) clauses, and the parser can only evaluate those against a known
   * country's holiday table. Without it, every museum tagged
   * "Tu-Su 10:00-18:00; PH off" reads as closed and vanishes from the plan.
   */
  countryCode?: string | null;
  /**
   * The city's English name, when it differs from `cityName`. Wikivoyage
   * articles are titled in English, so a city geocoded as 京都市 needs "Kyoto"
   * to find its guide at all (§5a).
   */
  englishName?: string | null;
};

export type Preferences = {
  pace: "relaxed" | "moderate" | "packed"; // target stops per day: 2-3 / 4-5 / 6-7
  dayStart: "early" | "midmorning" | "late"; // 07:00 / 09:30 / 11:00
  dayEnd: "early" | "moderate" | "late"; // 18:00 / 21:00 / late-night
  interests: Record<InterestTag, InterestLevel>; // 0 = avoid entirely, 3 = prioritise
  budget: "shoestring" | "moderate" | "comfortable" | "no-limit";
  mobility: "lots-of-walking-fine" | "moderate" | "minimal-walking";
  transport: "walk" | "transit" | "taxi" | "car";
  foodImportance: 0 | 1 | 2 | 3;
  avoidCrowds: boolean;
  travellingWith: "solo" | "partner" | "friends" | "kids" | "family-mixed";
};

export type InterestLevel = 0 | 1 | 2 | 3;

export type InterestTag =
  | "museums"
  | "history"
  | "architecture"
  | "art"
  | "nature"
  | "parks"
  | "viewpoints"
  | "beaches"
  | "food"
  | "cafes"
  | "markets"
  | "nightlife"
  | "shopping"
  | "neighbourhoods"
  | "religious-sites"
  | "offbeat"
  | "photography"
  | "live-music";

export type Poi = {
  id: string;
  /** Display name. OSM's `name:en` when there is one, otherwise `name`. */
  name: string;
  /**
   * The name in the local script, when it differs from the display name.
   * 3,069 of 3,353 candidates in Tokyo carry a Japanese `name` — an itinerary
   * that shows only those is unreadable to the traveller who asked for it, and
   * one that shows only the English is useless for pointing at a street sign or
   * showing a taxi driver. So both are kept.
   */
  localName: string | null;
  lat: number;
  lng: number;
  tags: InterestTag[];
  /**
   * The catalogue category this POI was classified into (src/shared/categories.ts).
   * An addition to the §3 model, not a replacement: `tags` still drives interest
   * matching, but the scheduler needs to know a restaurant from a museum to
   * fill meal slots (§7b), and §9c asks the UI to show a stop's category.
   * Null for user-added places, which have no source tags to classify.
   */
  category: CategoryKey | null;
  sourceIds: { osm?: string; wikidata?: string; wikivoyage?: string };
  openingHours: OpeningHours | null; // null = unknown, treat per §7c
  typicalDurationMin: number; // from category defaults, see §5c
  priceTier: 0 | 1 | 2 | 3 | null;
  score: number; // ranking output, §6
  rationale: string | null; // why it was chosen, §6c
  provenance: "osm" | "wikivoyage" | "wikidata" | "user-added";
};

/**
 * An OSM `opening_hours` value plus whatever we could resolve from it.
 * `raw` is the untouched tag; the parsing in src/core/hours.ts is what the
 * scheduler consults. Kept as an object rather than a bare string so a POI can
 * also carry hours that arrived from somewhere other than an OSM tag.
 */
export type OpeningHours = {
  raw: string;
  source: "osm" | "wikivoyage";
};

export type ScheduledStop = {
  poiId: string;
  arriveMin: number; // minutes from midnight
  departMin: number;
  travelFromPrevMin: number;
  pinned: boolean; // user-locked, scheduler must respect
  rationale: string | null;
};

export type ItineraryDay = {
  dayIndex: number;
  cityName: string;
  date: string | null;
  stops: ScheduledStop[];
  warnings: string[]; // e.g. "opening hours unknown for X"
};

// --- Supporting types --------------------------------------------------------

/**
 * A stop the scheduler could not fit, kept so the UI can offer it as an
 * alternative (§7a step 6, §9e).
 */
export type DroppedCandidate = {
  poiId: string;
  reason: string; // traveller-facing, e.g. "No time after the museum"
  dayIndex: number | null; // the day it was considered for, when known
  score: number;
};

/** A user constraint the scheduler must honour exactly (§8). */
export type Pin = {
  poiId: string;
  dayIndex: number | null; // pin to a day, or null for "any day"
  arriveMin: number | null; // pin to a time, or null for "anywhere that day"
};

/**
 * Travel times in minutes between POIs, keyed `${fromId}|${toId}`.
 * Computed once per city per generation (§5d), never per scheduling iteration.
 */
export type TravelMatrix = {
  mode: "walk" | "transit" | "taxi" | "car";
  /** True when durations are multiplier-derived rather than routed (§5d). */
  approximate: boolean;
  durations: Record<string, number>;
  /** Walking distance in metres, used for the daily walking cap (§7d). */
  distances: Record<string, number>;
};

/** A meal reservation in the day (§7b). */
export type MealSlot = {
  kind: "lunch" | "dinner";
  startMin: number;
  durationMin: number;
  /** A ranked food POI when food matters, otherwise time reserved unnamed. */
  poiId: string | null;
};

/** What the scheduler returns for one city. */
export type CityItinerary = {
  cityName: string;
  days: ItineraryDay[];
  meals: Record<number, MealSlot[]>; // dayIndex -> meals
  dropped: DroppedCandidate[];
};

/** The full generation result held in client state. */
export type Itinerary = {
  briefId: string;
  cities: CityItinerary[];
  /** Every POI referenced by any stop, so the client can render without refetch. */
  pois: Record<string, Poi>;
  /** Per-generation instrumentation counters (§10). */
  counters: PipelineCounters;
  /** Generation-level notes the UI shows, e.g. degraded editorial coverage. */
  notes: string[];
};

export type PipelineCounters = {
  overpassQueries: number;
  osrmCalls: number;
  wikivoyageFetches: number;
  wikidataFetches: number;
  llmCalls: number;
  cacheHits: number;
  cacheMisses: number;
};

/** Adjustments the LLM may make to the preference model (§6b job 1). */
export type PreferenceDiff = {
  interestDeltas: Partial<Record<InterestTag, number>>;
  hardConstraints: HardConstraint[];
  specialRequests: SpecialRequest[];
  notes: string[];
};

export type HardConstraint =
  | { kind: "no-stairs" }
  | { kind: "step-free" }
  | { kind: "max-walking-metres"; value: number }
  | { kind: "avoid-tag"; tag: InterestTag };

export type SpecialRequest = {
  /** e.g. "one really nice dinner" — resolved by semantic matching (§6b job 2). */
  descriptor: string;
  slot: "dinner" | "lunch" | "any";
  dayIndex: number | null;
};
