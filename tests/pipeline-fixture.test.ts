import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { generateItinerary } from "../src/server/pipeline/generate.js";
import { clearSourcingCache } from "../src/server/pipeline/sourcing.js";
import { resolveHours, fitsWithinHours } from "../src/core/hours.js";
import { PACE_TARGETS } from "../src/shared/planning-config.js";
import { defaultPreferences } from "../src/shared/preferences.js";
import { weekdayOf } from "../src/shared/dates.js";
import type { Itinerary, TripBrief } from "../src/shared/types.js";

/**
 * §11a/§11b — the whole pipeline, end to end, from recorded responses with no
 * network and no keys. This is the "what counts as done" list, run for real:
 * sourcing, matching, ranking, the travel matrix and the scheduler all execute
 * their production code paths; only the transport is replaced (§11c).
 */

const originalFixtureMode = process.env.FIXTURE_MODE;

beforeAll(() => {
  process.env.FIXTURE_MODE = "true";
  clearSourcingCache();
});

afterAll(() => {
  if (originalFixtureMode === undefined) delete process.env.FIXTURE_MODE;
  else process.env.FIXTURE_MODE = originalFixtureMode;
});

/** A Monday arrival, so weekday closures are actually exercised. */
const MONDAY = "2026-09-07";

function twoCityBrief(overrides: Partial<TripBrief> = {}): TripBrief {
  const preferences = defaultPreferences();
  preferences.interests.museums = 3;
  preferences.interests.food = 2;
  preferences.interests.viewpoints = 2;
  return {
    id: "test-trip",
    name: "A week in Portugal",
    cities: [
      {
        cityName: "Porto",
        lat: 41.1502195,
        lng: -8.6103497,
        startDate: MONDAY,
        days: 3,
        basecampLat: null,
        basecampLng: null,
      },
      {
        cityName: "Lisbon",
        lat: 38.7077507,
        lng: -9.1365919,
        startDate: "2026-09-10",
        days: 3,
        basecampLat: null,
        basecampLng: null,
      },
    ],
    preferences,
    freeText: null,
    ...overrides,
  };
}

let itinerary: Itinerary;

beforeAll(async () => {
  itinerary = await generateItinerary({ brief: twoCityBrief(), pins: [], reuseCandidates: false });
}, 30_000);

describe("a two-city trip from recorded data (§11b)", () => {
  it("produces a full itinerary with no unhandled errors", () => {
    expect(itinerary.cities).toHaveLength(2);
    expect(itinerary.cities[0].cityName).toBe("Porto");
    expect(itinerary.cities[1].cityName).toBe("Lisbon");
    for (const city of itinerary.cities) {
      expect(city.days).toHaveLength(3);
      expect(city.days.some((d) => d.stops.length > 0)).toBe(true);
    }
  });

  it("no scheduled stop falls outside its POI's known opening hours", () => {
    let checked = 0;
    for (const city of itinerary.cities) {
      for (const day of city.days) {
        for (const stop of day.stops) {
          const poi = itinerary.pois[stop.poiId];
          expect(poi, `no POI for scheduled stop ${stop.poiId}`).toBeDefined();
          const res = resolveHours(poi.openingHours, day.date, poi);
          expect(
            fitsWithinHours(res, stop.arriveMin, stop.departMin),
            `${poi.name} on ${day.date}: ${stop.arriveMin}-${stop.departMin} vs ${JSON.stringify(res)}`,
          ).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("never puts a place on a weekday it is closed", () => {
    for (const city of itinerary.cities) {
      for (const day of city.days) {
        const weekday = weekdayOf(day.date);
        if (weekday === null) continue;
        for (const stop of day.stops) {
          const poi = itinerary.pois[stop.poiId];
          const res = resolveHours(poi.openingHours, day.date, poi);
          if (res.kind === "known") expect(res.windows.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("every stop traces back to a real retrieved POI id (§6b)", () => {
    const known = new Set(Object.keys(itinerary.pois));
    for (const city of itinerary.cities) {
      for (const day of city.days) {
        for (const stop of day.stops) expect(known.has(stop.poiId)).toBe(true);
      }
      for (const slots of Object.values(city.meals)) {
        for (const slot of slots) {
          if (slot.poiId) expect(known.has(slot.poiId)).toBe(true);
        }
      }
      for (const dropped of city.dropped) expect(known.has(dropped.poiId)).toBe(true);
    }
  });

  it("every POI it scheduled came from a real source, not from nowhere", () => {
    for (const city of itinerary.cities) {
      for (const day of city.days) {
        for (const stop of day.stops) {
          const poi = itinerary.pois[stop.poiId];
          expect(["osm", "wikivoyage", "wikidata", "user-added"]).toContain(poi.provenance);
          expect(
            poi.sourceIds.osm || poi.sourceIds.wikivoyage || poi.sourceIds.wikidata,
          ).toBeTruthy();
          expect(poi.name.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("respects the pace setting within one stop", () => {
    const target = PACE_TARGETS.moderate;
    for (const city of itinerary.cities) {
      for (const day of city.days) {
        expect(day.stops.length).toBeLessThanOrEqual(target.max + 1);
      }
    }
  });

  it("names every unverified stop in the day's warnings (§9d)", () => {
    for (const city of itinerary.cities) {
      for (const day of city.days) {
        for (const stop of day.stops) {
          const poi = itinerary.pois[stop.poiId];
          if (poi.openingHours !== null) continue;
          expect(
            day.warnings.some((w) => w.includes(poi.name)),
            `${poi.name} has unknown hours but is not named in the day's warnings`,
          ).toBe(true);
        }
      }
    }
  });

  it("offers what it dropped, with a reason written for a traveller", () => {
    const dropped = itinerary.cities.flatMap((c) => c.dropped);
    expect(dropped.length).toBeGreaterThan(0);
    for (const entry of dropped.slice(0, 25)) {
      expect(entry.reason.length).toBeGreaterThan(3);
      expect(entry.reason).not.toMatch(/undefined|null|opening_hours|NaN/);
    }
  });

  it("reports its third-party call count and makes no LLM calls without a key", () => {
    expect(itinerary.counters.overpassQueries).toBeGreaterThan(0);
    expect(itinerary.counters.wikivoyageFetches).toBeGreaterThan(0);
    expect(itinerary.counters.llmCalls).toBe(0);
  });

  it("makes exactly one Overpass query per city per generation (§10)", () => {
    // Two cities, one query each — not one per category, not one per day.
    expect(itinerary.counters.overpassQueries).toBe(2);
    expect(itinerary.counters.osrmCalls).toBe(2);
  });
});

describe("skipping the interview entirely (§11b)", () => {
  it("still produces a reasonable itinerary from defaults", async () => {
    clearSourcingCache();
    const result = await generateItinerary({
      brief: {
        id: "defaults",
        name: "",
        cities: [
          {
            cityName: "Porto",
            lat: 41.1502195,
            lng: -8.6103497,
            startDate: null,
            days: 2,
            basecampLat: null,
            basecampLng: null,
          },
        ],
        preferences: defaultPreferences(),
        freeText: null,
      },
      pins: [],
      reuseCandidates: false,
    });

    const stops = result.cities[0].days.flatMap((d) => d.stops);
    expect(stops.length).toBeGreaterThanOrEqual(4);
    // Dateless stays cannot verify weekday closures, and must say so (§7c).
    expect(result.cities[0].days[0].warnings.join(" ")).toMatch(/no dates set/i);
  }, 30_000);
});

describe("pinning (§8, §11b)", () => {
  it("puts a pinned stop at exactly the pinned time", async () => {
    clearSourcingCache();
    const first = await generateItinerary({
      brief: twoCityBrief({ cities: [twoCityBrief().cities[0]] }),
      pins: [],
      reuseCandidates: false,
    });
    const target = first.cities[0].days[0].stops[0];
    expect(target).toBeDefined();

    const pinned = await generateItinerary({
      brief: twoCityBrief({ cities: [twoCityBrief().cities[0]] }),
      pins: [{ poiId: target.poiId, dayIndex: 2, arriveMin: 15 * 60 }],
      reuseCandidates: true,
    });

    const stop = pinned.cities[0].days[2].stops.find((s) => s.poiId === target.poiId);
    expect(stop, "the pinned stop is missing from the day it was pinned to").toBeDefined();
    expect(stop!.arriveMin).toBe(15 * 60);
    expect(stop!.pinned).toBe(true);
  }, 40_000);
});

describe("the free-text box without a language model (§6b, §0c)", () => {
  it("reads a mobility constraint deterministically and plans around it", async () => {
    clearSourcingCache();
    const result = await generateItinerary({
      brief: twoCityBrief({
        cities: [twoCityBrief().cities[0]],
        freeText: "My mother can't manage stairs, and we'd like one really nice dinner.",
      }),
      pins: [],
      reuseCandidates: false,
    });
    expect(result.notes.join(" ")).toMatch(/step-free/i);
    expect(result.counters.llmCalls).toBe(0);
  }, 30_000);
});
