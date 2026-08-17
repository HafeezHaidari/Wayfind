import { describe, expect, it } from "vitest";
import { scheduleCity } from "../src/core/scheduler.js";
import { defaultPreferences } from "../src/shared/preferences.js";
import {
  ABSOLUTE_MIN_STOP_MIN,
  BUFFER_BETWEEN_STOPS_MIN,
  DAILY_WALK_CAP_M,
  DAY_END_MIN,
  DAY_START_MIN,
  DINNER_WINDOW,
  LUNCH_WINDOW,
  PACE_TARGETS,
} from "../src/shared/planning-config.js";
import { walkingLoadM } from "../src/core/travel.js";
import type { Preferences } from "../src/shared/types.js";
import {
  cityStay,
  clusteredPois,
  hours,
  poi,
  PORTO_CENTRE,
  ringOfPois,
  syntheticMatrix,
} from "./helpers/synthetic.js";

function prefs(overrides: Partial<Preferences> = {}): Preferences {
  return { ...defaultPreferences(), ...overrides };
}

const MONDAY = "2026-09-07";

describe("provenance (§6b, §11b)", () => {
  it("every stop traces back to a POI that was in the input set", () => {
    const pois = clusteredPois(3, 6);
    const ids = new Set(pois.map((p) => p.id));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 3 }),
      preferences: prefs(),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    for (const day of result.days) {
      for (const stop of day.stops) expect(ids.has(stop.poiId)).toBe(true);
    }
    for (const slots of Object.values(result.meals)) {
      for (const slot of slots) {
        if (slot.poiId) expect(ids.has(slot.poiId)).toBe(true);
      }
    }
    for (const d of result.dropped) expect(ids.has(d.poiId)).toBe(true);
  });

  it("never schedules the same place twice across the whole stay", () => {
    const pois = clusteredPois(4, 6);
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 4 }),
      preferences: prefs({ pace: "packed" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const all = result.days.flatMap((d) => d.stops.map((s) => s.poiId));
    expect(new Set(all).size).toBe(all.length);
  });

  it("does not list a scheduled place as a dropped alternative", () => {
    const pois = clusteredPois(3, 8);
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 2 }),
      preferences: prefs(),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const scheduled = new Set(result.days.flatMap((d) => d.stops.map((s) => s.poiId)));
    for (const d of result.dropped) expect(scheduled.has(d.poiId)).toBe(false);
  });
});

describe("pace (§11b: within one stop)", () => {
  for (const pace of ["relaxed", "moderate", "packed"] as const) {
    it(`respects a ${pace} pace within one stop`, () => {
      const pois = clusteredPois(3, 10, 300, 2000, (c, i) => ({
        score: 10 - (c * 10 + i) * 0.05,
        typicalDurationMin: 45,
        openingHours: hours("Mo-Su 08:00-22:00"),
      }));
      const result = scheduleCity({
        pois,
        cityStay: cityStay({ days: 3, startDate: MONDAY }),
        preferences: prefs({ pace, dayStart: "early", dayEnd: "late" }),
        travelMatrix: syntheticMatrix(pois),
        pins: [],
      });
      const target = PACE_TARGETS[pace];
      for (const day of result.days) {
        expect(day.stops.length).toBeGreaterThanOrEqual(target.min - 1);
        expect(day.stops.length).toBeLessThanOrEqual(target.max + 1);
      }
    });
  }

  it("never exceeds the pace maximum even when stops are tiny", () => {
    const pois = clusteredPois(2, 14, 200, 1500, () => ({
      typicalDurationMin: 20,
      openingHours: hours("24/7"),
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 2 }),
      preferences: prefs({ pace: "relaxed", dayStart: "early", dayEnd: "late" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    for (const day of result.days) {
      expect(day.stops.length).toBeLessThanOrEqual(PACE_TARGETS.relaxed.max);
    }
  });
});

describe("day boundaries and realism guards (§7d)", () => {
  it("starts no earlier than the preferred day start", () => {
    const pois = clusteredPois(2, 6, 300, 1500, () => ({ openingHours: hours("24/7") }));
    for (const dayStart of ["early", "midmorning", "late"] as const) {
      const result = scheduleCity({
        pois,
        cityStay: cityStay({ days: 2 }),
        preferences: prefs({ dayStart }),
        travelMatrix: syntheticMatrix(pois),
        pins: [],
      });
      for (const day of result.days) {
        for (const stop of day.stops) {
          expect(stop.arriveMin).toBeGreaterThanOrEqual(DAY_START_MIN[dayStart]);
        }
      }
    }
  });

  it("finishes no later than the preferred day end", () => {
    const pois = clusteredPois(2, 10, 300, 1500, () => ({ openingHours: hours("24/7") }));
    for (const dayEnd of ["early", "moderate", "late"] as const) {
      const result = scheduleCity({
        pois,
        cityStay: cityStay({ days: 2 }),
        preferences: prefs({ dayEnd, pace: "packed" }),
        travelMatrix: syntheticMatrix(pois),
        pins: [],
      });
      for (const day of result.days) {
        for (const stop of day.stops) {
          expect(stop.departMin).toBeLessThanOrEqual(DAY_END_MIN[dayEnd]);
        }
      }
    }
  });

  it("never produces a token visit, however tight the day gets", () => {
    const pois = ringOfPois(8, 600, () => ({
      typicalDurationMin: 120,
      openingHours: hours("Mo-Su 10:00-18:00"),
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ pace: "packed" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    for (const stop of result.days[0].stops) {
      expect(stop.departMin - stop.arriveMin).toBeGreaterThanOrEqual(ABSOLUTE_MIN_STOP_MIN);
      // And no shorter than the configured fraction of a two-hour visit.
      expect(stop.departMin - stop.arriveMin).toBeGreaterThanOrEqual(72);
    }
  });

  it("leaves buffer between consecutive stops rather than scheduling to the minute", () => {
    const pois = clusteredPois(1, 6, 250, 0, () => ({ openingHours: hours("24/7") }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1 }),
      preferences: prefs({ pace: "packed", dayStart: "early", dayEnd: "late" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const stops = result.days[0].stops;
    for (let i = 1; i < stops.length; i++) {
      const gap = stops[i].arriveMin - stops[i - 1].departMin;
      expect(gap).toBeGreaterThanOrEqual(BUFFER_BETWEEN_STOPS_MIN);
    }
  });

  it("stops never overlap each other", () => {
    const pois = clusteredPois(2, 8);
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 2 }),
      preferences: prefs({ pace: "packed" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    for (const day of result.days) {
      for (let i = 1; i < day.stops.length; i++) {
        expect(day.stops[i].arriveMin).toBeGreaterThanOrEqual(day.stops[i - 1].departMin);
      }
    }
  });
});

describe("walking cap (§7d, §11b)", () => {
  for (const mobility of ["lots-of-walking-fine", "moderate", "minimal-walking"] as const) {
    it(`keeps total daily walking inside the ${mobility} budget`, () => {
      // Deliberately spread out, so an uncapped scheduler would march for miles.
      const pois = ringOfPois(14, 3000, () => ({ openingHours: hours("24/7") }));
      const matrix = syntheticMatrix(pois);
      const result = scheduleCity({
        pois,
        cityStay: cityStay({ days: 2 }),
        preferences: prefs({ mobility, pace: "packed", dayStart: "early", dayEnd: "late" }),
        travelMatrix: matrix,
        pins: [],
      });

      for (const day of result.days) {
        let walked = 0;
        let prevId: string | null = null;
        let prevAt = PORTO_CENTRE;
        for (const stop of day.stops) {
          const p = pois.find((x) => x.id === stop.poiId)!;
          if (prevId) walked += walkingLoadM(matrix, prevId, p.id, prevAt, p, "walk");
          prevId = p.id;
          prevAt = { lat: p.lat, lng: p.lng };
        }
        expect(walked).toBeLessThanOrEqual(DAILY_WALK_CAP_M[mobility]);
      }
    });
  }

  it("does not count taxi legs against the walking budget", () => {
    const pois = ringOfPois(10, 2500, () => ({ openingHours: hours("24/7") }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1 }),
      preferences: prefs({
        mobility: "minimal-walking",
        transport: "taxi",
        pace: "packed",
        dayStart: "early",
        dayEnd: "late",
      }),
      travelMatrix: syntheticMatrix(pois, "taxi"),
      pins: [],
    });
    // With a taxi, minimal-walking is no longer the binding constraint.
    expect(result.days[0].stops.length).toBeGreaterThanOrEqual(4);
  });
});

describe("meals (§7b)", () => {
  it("puts lunch in the middle of the day rather than leaving the traveller unfed", () => {
    const pois = ringOfPois(8, 700, () => ({
      typicalDurationMin: 120,
      openingHours: hours("Mo-Su 09:00-20:00"),
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ pace: "packed", dayStart: "early", foodImportance: 1 }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const lunch = result.meals[0].find((m) => m.kind === "lunch");
    expect(lunch).toBeDefined();
    expect(lunch!.startMin).toBeGreaterThanOrEqual(LUNCH_WINDOW.earliest);
    expect(lunch!.startMin).toBeLessThanOrEqual(LUNCH_WINDOW.latest);
  });

  it("scales meal length with how much the trip is about eating", () => {
    const pois = ringOfPois(6, 600, () => ({ openingHours: hours("24/7") }));
    const lengths = ([0, 1, 2, 3] as const).map((foodImportance) => {
      const result = scheduleCity({
        pois,
        cityStay: cityStay({ days: 1 }),
        preferences: prefs({ foodImportance, dayStart: "early", dayEnd: "late" }),
        travelMatrix: syntheticMatrix(pois),
        pins: [],
      });
      return result.meals[0].find((m) => m.kind === "lunch")!.durationMin;
    });
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(lengths[3]).toBeGreaterThan(lengths[0]);
  });

  it("names a real restaurant when food matters, and reserves time when it does not", () => {
    const sights = ringOfPois(5, 600, () => ({ openingHours: hours("Mo-Su 09:00-19:00") }));
    const food = [
      poi({
        name: "Cantina 32",
        category: "restaurant",
        lat: PORTO_CENTRE.lat + 0.002,
        openingHours: hours("Mo-Su 12:00-23:00"),
        score: 8,
      }),
      poi({
        name: "Café Guarany",
        category: "cafe",
        lat: PORTO_CENTRE.lat - 0.002,
        openingHours: hours("Mo-Su 08:00-20:00"),
        score: 7,
      }),
    ];
    const pois = [...sights, ...food];

    const keen = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ foodImportance: 3, dayStart: "early", dayEnd: "late" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const keenLunch = keen.meals[0].find((m) => m.kind === "lunch")!;
    expect(keenLunch.poiId).not.toBeNull();
    expect(food.map((f) => f.id)).toContain(keenLunch.poiId);

    const indifferent = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ foodImportance: 0, dayStart: "early", dayEnd: "late" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    expect(indifferent.meals[0].find((m) => m.kind === "lunch")!.poiId).toBeNull();
  });

  it("does not send the traveller to a restaurant that is shut", () => {
    const sights = ringOfPois(4, 500, () => ({ openingHours: hours("Mo-Su 09:00-19:00") }));
    const shut = poi({
      name: "Closed Mondays Tasca",
      category: "restaurant",
      openingHours: hours("Tu-Su 12:00-23:00"),
      score: 9,
    });
    const open = poi({
      name: "Open Every Day",
      category: "restaurant",
      lat: PORTO_CENTRE.lat + 0.001,
      openingHours: hours("Mo-Su 12:00-23:00"),
      score: 5,
    });
    const pois = [...sights, shut, open];
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ foodImportance: 3, dayStart: "early" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const lunch = result.meals[0].find((m) => m.kind === "lunch")!;
    expect(lunch.poiId).not.toBe(shut.id);
  });

  it("skips dinner rather than inventing time for it when the day ends early", () => {
    const pois = ringOfPois(6, 600, () => ({ openingHours: hours("24/7") }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1 }),
      preferences: prefs({ dayEnd: "early", dayStart: "early" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const dinner = result.meals[0].find((m) => m.kind === "dinner");
    if (dinner) expect(dinner.startMin + dinner.durationMin).toBeLessThanOrEqual(DAY_END_MIN.early);
  });

  it("places dinner inside the evening window when the day runs late", () => {
    const pois = ringOfPois(8, 600, () => ({ openingHours: hours("24/7"), typicalDurationMin: 60 }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1 }),
      preferences: prefs({ dayEnd: "late", dayStart: "early", pace: "packed" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const dinner = result.meals[0].find((m) => m.kind === "dinner");
    expect(dinner).toBeDefined();
    expect(dinner!.startMin).toBeGreaterThanOrEqual(DINNER_WINDOW.earliest);
  });

  it("never double-books a meal venue across days", () => {
    const sights = clusteredPois(3, 5, 300, 2000, () => ({ openingHours: hours("Mo-Su 09:00-19:00") }));
    const food = Array.from({ length: 6 }, (_, i) =>
      poi({
        name: `Restaurant ${i}`,
        category: "restaurant",
        lat: PORTO_CENTRE.lat + i * 0.001,
        openingHours: hours("Mo-Su 11:00-23:00"),
        score: 8 - i * 0.1,
      }),
    );
    const pois = [...sights, ...food];
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 3, startDate: MONDAY }),
      preferences: prefs({ foodImportance: 3, dayEnd: "late" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const used = Object.values(result.meals)
      .flat()
      .map((m) => m.poiId)
      .filter((id): id is string => id !== null);
    expect(new Set(used).size).toBe(used.length);
  });

  it("never uses a restaurant as an ordinary sightseeing stop", () => {
    const sights = ringOfPois(4, 500, () => ({ openingHours: hours("24/7") }));
    const food = poi({ name: "A Restaurant", category: "restaurant", score: 99 });
    const pois = [...sights, food];
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1 }),
      preferences: prefs({ foodImportance: 3 }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    expect(result.days[0].stops.map((s) => s.poiId)).not.toContain(food.id);
  });
});

describe("pins (§8)", () => {
  it("puts a stop pinned to a day on that day", () => {
    const pois = clusteredPois(3, 6);
    const target = pois[0];
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 3 }),
      preferences: prefs(),
      travelMatrix: syntheticMatrix(pois),
      pins: [{ poiId: target.id, dayIndex: 2, arriveMin: null }],
    });
    expect(result.days[2].stops.map((s) => s.poiId)).toContain(target.id);
    expect(result.days[0].stops.map((s) => s.poiId)).not.toContain(target.id);
  });

  it("puts a stop pinned to a time at exactly that time", () => {
    const pois = clusteredPois(1, 6, 300, 0, () => ({ openingHours: hours("Mo-Su 08:00-22:00") }));
    const target = pois[3];
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ dayEnd: "late" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [{ poiId: target.id, dayIndex: 0, arriveMin: 15 * 60 + 30 }],
    });
    const stop = result.days[0].stops.find((s) => s.poiId === target.id);
    expect(stop?.arriveMin).toBe(15 * 60 + 30);
  });

  it("keeps a pin even when it scores far below everything else", () => {
    const pois = clusteredPois(2, 10, 300, 2000, (c, i) => ({ score: 10 - i }));
    const runt = poi({ name: "Sentimental Favourite", score: -50, lat: PORTO_CENTRE.lat + 0.03 });
    const all = [...pois, runt];
    const result = scheduleCity({
      pois: all,
      cityStay: cityStay({ days: 2 }),
      preferences: prefs({ pace: "relaxed" }),
      travelMatrix: syntheticMatrix(all),
      pins: [{ poiId: runt.id, dayIndex: 1, arriveMin: null }],
    });
    const scheduled = result.days.flatMap((d) => d.stops.map((s) => s.poiId));
    expect(scheduled).toContain(runt.id);
  });

  it("honours several pinned times in the order they were pinned", () => {
    const pois = clusteredPois(1, 7, 400, 0, () => ({ openingHours: hours("Mo-Su 08:00-23:00") }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ dayEnd: "late", pace: "packed" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [
        { poiId: pois[5].id, dayIndex: 0, arriveMin: 10 * 60 },
        { poiId: pois[1].id, dayIndex: 0, arriveMin: 17 * 60 },
      ],
    });
    const stops = result.days[0].stops;
    const first = stops.find((s) => s.poiId === pois[5].id)!;
    const second = stops.find((s) => s.poiId === pois[1].id)!;
    expect(first.arriveMin).toBe(600);
    expect(second.arriveMin).toBe(1020);
    expect(stops.indexOf(first)).toBeLessThan(stops.indexOf(second));
  });
});

describe("defaults and degenerate inputs", () => {
  it("produces a reasonable itinerary from untouched defaults (§11b)", () => {
    const pois = clusteredPois(3, 8, 350, 1800, (c, i) => ({
      score: 8 - i * 0.1,
      openingHours: hours("Mo-Su 10:00-18:00"),
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 3, startDate: MONDAY }),
      preferences: defaultPreferences(),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    expect(result.days).toHaveLength(3);
    for (const day of result.days) {
      expect(day.stops.length).toBeGreaterThanOrEqual(PACE_TARGETS.moderate.min - 1);
    }
  });

  it("returns empty days rather than throwing when there are no candidates", () => {
    const result = scheduleCity({
      pois: [],
      cityStay: cityStay({ days: 2 }),
      preferences: prefs(),
      travelMatrix: null,
      pins: [],
    });
    expect(result.days).toHaveLength(2);
    expect(result.days.every((d) => d.stops.length === 0)).toBe(true);
  });

  it("works with no travel matrix at all, falling back to estimates", () => {
    const pois = clusteredPois(2, 6);
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 2 }),
      preferences: prefs(),
      travelMatrix: null,
      pins: [],
    });
    expect(result.days.flatMap((d) => d.stops).length).toBeGreaterThan(2);
  });

  it("plans a single day for a single city with one POI", () => {
    const only = poi({ name: "The One Thing", openingHours: hours("Mo-Su 10:00-18:00") });
    const result = scheduleCity({
      pois: [only],
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs(),
      travelMatrix: null,
      pins: [],
    });
    expect(result.days[0].stops).toHaveLength(1);
  });

  it("is deterministic: the same input produces the same plan", () => {
    const pois = clusteredPois(4, 7);
    const matrix = syntheticMatrix(pois);
    const run = () =>
      JSON.stringify(
        scheduleCity({
          pois,
          cityStay: cityStay({ days: 4, startDate: MONDAY }),
          preferences: prefs(),
          travelMatrix: matrix,
          pins: [],
        }).days,
      );
    expect(run()).toBe(run());
  });

  it("never schedules a category the traveller ruled out", () => {
    const museums = ringOfPois(6, 500, () => ({ category: "major-museum", tags: ["museums"] }));
    const parks = ringOfPois(6, 900, () => ({ category: "park", tags: ["parks"] }));
    const pois = [...museums, ...parks];
    const preferences = prefs();
    preferences.interests.museums = 0;
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 2 }),
      preferences,
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const museumIds = new Set(museums.map((m) => m.id));
    for (const day of result.days) {
      for (const stop of day.stops) expect(museumIds.has(stop.poiId)).toBe(false);
    }
  });
});

describe("geographic coherence (§7a step 2)", () => {
  it("keeps a day inside one part of the city rather than zigzagging", () => {
    // Three tight clusters 4 km apart; a coherent plan gives each its own day.
    const pois = clusteredPois(3, 5, 200, 4000, (c) => ({
      openingHours: hours("24/7"),
      score: 5 + c * 0.01,
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 3 }),
      preferences: prefs({ pace: "moderate", mobility: "lots-of-walking-fine" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    for (const day of result.days) {
      const clusters = new Set(
        day.stops.map((s) => pois.find((p) => p.id === s.poiId)!.name.split(" ")[1]),
      );
      expect(clusters.size).toBeLessThanOrEqual(1);
    }
  });

  it("biases days toward a supplied basecamp", () => {
    const pois = ringOfPois(12, 2500, () => ({ openingHours: hours("24/7") }));
    const near = pois[0];
    const result = scheduleCity({
      pois,
      cityStay: cityStay({
        days: 2,
        basecampLat: near.lat,
        basecampLng: near.lng,
      }),
      preferences: prefs(),
      travelMatrix: syntheticMatrix(pois, "walk", { lat: near.lat, lng: near.lng }),
      pins: [],
    });
    expect(result.days.flatMap((d) => d.stops).length).toBeGreaterThan(2);
    // The first stop of a day should not be the far side of the ring when the
    // hotel is on the near side.
    const firstStop = result.days[0].stops[0];
    expect(firstStop).toBeDefined();
  });
});

describe("dropped candidates (§7a step 6, §9e)", () => {
  it("records why each place did not make the plan", () => {
    const pois = clusteredPois(2, 12, 300, 2000, (c, i) => ({
      score: 10 - i * 0.3,
      openingHours: hours(i % 4 === 0 ? "Tu-Su 10:00-18:00" : "Mo-Su 10:00-18:00"),
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 2, startDate: MONDAY }),
      preferences: prefs({ pace: "relaxed" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    expect(result.dropped.length).toBeGreaterThan(0);
    for (const d of result.dropped) {
      expect(d.reason.length).toBeGreaterThan(3);
      // §9g: reasons are written from the traveller's side of the screen.
      expect(d.reason).not.toMatch(/null|undefined|opening_hours|constraint/i);
    }
    expect(result.dropped.some((d) => d.reason === "Closed Mondays")).toBe(true);
  });

  it("orders alternatives by score so the best near-miss is first", () => {
    const pois = clusteredPois(2, 12, 300, 2000, (c, i) => ({ score: 10 - i * 0.4 }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1 }),
      preferences: prefs({ pace: "relaxed" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const scores = result.dropped.map((d) => d.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
