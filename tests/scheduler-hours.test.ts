import { describe, expect, it } from "vitest";
import { scheduleCity } from "../src/core/scheduler.js";
import { resolveHours, fitsWithinHours } from "../src/core/hours.js";
import { defaultPreferences } from "../src/shared/preferences.js";
import { dateForDay, weekdayOf } from "../src/shared/dates.js";
import type { ItineraryDay, Poi, Preferences } from "../src/shared/types.js";
import {
  cityStay,
  clusteredPois,
  hours,
  poi,
  PORTO_CENTRE,
  ringOfPois,
  syntheticMatrix,
} from "./helpers/synthetic.js";

/**
 * §11b: "No scheduled stop falls outside its POI's known opening hours. This is
 * the single most important test in the suite; write it first and make it
 * comprehensive."
 *
 * This file is that test. Everything here checks the same invariant from a
 * different angle, because a scheduler that respects hours in the easy case and
 * not the awkward one is a scheduler that will send someone to a closed museum.
 *
 * The one documented exception is a stop the user pinned to a specific time:
 * §8 forbids moving or dropping a pin, so the scheduler keeps it and warns.
 * That case is asserted separately at the bottom.
 */

/** The invariant, applied to a whole itinerary. */
function assertEveryStopIsOpen(days: ItineraryDay[], pois: Poi[]) {
  const byId = new Map(pois.map((p) => [p.id, p]));
  let checked = 0;
  for (const day of days) {
    for (const stop of day.stops) {
      const p = byId.get(stop.poiId);
      expect(p, `stop ${stop.poiId} has no matching POI`).toBeDefined();
      if (!p) continue;
      if (stop.pinned) continue; // §8 exception, asserted separately
      const res = resolveHours(p.openingHours, day.date, { lat: p.lat, lng: p.lng });
      expect(
        fitsWithinHours(res, stop.arriveMin, stop.departMin),
        `${p.name} on ${day.date ?? `day ${day.dayIndex}`} scheduled ${stop.arriveMin}-${stop.departMin} ` +
          `but hours are ${JSON.stringify(res)}`,
      ).toBe(true);
      checked++;
    }
  }
  return checked;
}

function prefs(overrides: Partial<Preferences> = {}): Preferences {
  return { ...defaultPreferences(), ...overrides };
}

const MONDAY = "2026-09-07";

describe("the opening-hours invariant", () => {
  it("never schedules a stop outside plain daily hours", () => {
    const pois = ringOfPois(12, 900, (i) => ({
      openingHours: hours(i % 2 === 0 ? "Mo-Su 10:00-18:00" : "Mo-Su 09:00-13:00"),
      score: 10 - i * 0.1,
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 2, startDate: MONDAY }),
      preferences: prefs({ pace: "packed" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    expect(assertEveryStopIsOpen(result.days, pois)).toBeGreaterThan(4);
  });

  it("never schedules across a midday closure", () => {
    const pois = ringOfPois(10, 700, () => ({
      openingHours: hours("Mo-Su 09:00-12:30,15:00-19:00"),
      typicalDurationMin: 90,
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 2, startDate: MONDAY }),
      preferences: prefs({ pace: "packed", dayStart: "early" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const checked = assertEveryStopIsOpen(result.days, pois);
    expect(checked).toBeGreaterThan(2);
    // And specifically: nothing straddles the 12:30-15:00 gap.
    for (const day of result.days) {
      for (const stop of day.stops) {
        expect(stop.arriveMin < 750 && stop.departMin > 750).toBe(false);
      }
    }
  });

  it("never schedules a place before it opens, however early the day starts", () => {
    const pois = ringOfPois(8, 600, () => ({ openingHours: hours("Mo-Su 14:00-20:00") }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ dayStart: "early", dayEnd: "late", pace: "packed" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    assertEveryStopIsOpen(result.days, pois);
    for (const stop of result.days[0].stops) expect(stop.arriveMin).toBeGreaterThanOrEqual(840);
  });

  it("never schedules a place that shuts before the day even starts", () => {
    const pois = ringOfPois(6, 600, () => ({ openingHours: hours("Mo-Su 06:00-08:00") }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ dayStart: "late" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    expect(result.days[0].stops).toHaveLength(0);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.dropped[0].reason).toMatch(/closes|open/i);
  });

  it("respects seasonal hours against the actual date", () => {
    const winter = ringOfPois(6, 500, () => ({
      openingHours: hours("Apr-Sep: Mo-Su 09:00-20:00; Oct-Mar: Mo-Su 10:00-16:00"),
      typicalDurationMin: 60,
    }));
    const result = scheduleCity({
      pois: winter,
      cityStay: cityStay({ days: 1, startDate: "2026-01-12" }),
      preferences: prefs({ pace: "packed", dayEnd: "late" }),
      travelMatrix: syntheticMatrix(winter),
      pins: [],
    });
    assertEveryStopIsOpen(result.days, winter);
    for (const stop of result.days[0].stops) expect(stop.departMin).toBeLessThanOrEqual(960);
  });

  it("holds when hours differ wildly across the candidate set", () => {
    const patterns = [
      "Mo-Su 10:00-18:00",
      "Tu-Su 09:30-17:30",
      "Mo-Fr 08:00-12:00,14:00-18:00",
      "We-Mo 11:00-19:00",
      "Sa,Su 10:00-14:00",
      "24/7",
      "Mo-Su 12:00-23:00",
      "Th-Sa 18:00-02:00",
    ];
    const pois = clusteredPois(3, 6, 300, 2200, (c, i) => ({
      openingHours: hours(patterns[(c * 6 + i) % patterns.length]),
      score: 10 - (c * 6 + i) * 0.2,
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 3, startDate: MONDAY }),
      preferences: prefs({ pace: "packed", dayStart: "early", dayEnd: "late" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    expect(assertEveryStopIsOpen(result.days, pois)).toBeGreaterThan(6);
  });

  it("holds when the stay has no dates and hours must come from a typical week", () => {
    const pois = ringOfPois(10, 800, (i) => ({
      openingHours: hours(i % 3 === 0 ? "Tu-Su 10:00-18:00" : "Mo-Su 11:00-17:00"),
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 2, startDate: null }),
      preferences: prefs({ pace: "moderate" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    assertEveryStopIsOpen(result.days, pois);
    // And the day must say the check could not be made (§7c).
    expect(result.days[0].warnings.join(" ")).toMatch(/no dates set/i);
  });

  it("still schedules places with unknown hours, but names them in the warnings", () => {
    const known = ringOfPois(4, 500, () => ({ openingHours: hours("Mo-Su 10:00-18:00") }));
    const unknown = [
      poi({ name: "Unmarked Chapel", lat: PORTO_CENTRE.lat + 0.004, openingHours: null, score: 9 }),
    ];
    const pois = [...known, ...unknown];
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ pace: "packed" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const scheduled = result.days[0].stops.map((s) => s.poiId);
    expect(scheduled).toContain(unknown[0].id);
    expect(result.days[0].warnings.join(" ")).toContain("Unmarked Chapel");
  });

  it("does not warn about places whose hours are known and unambiguous", () => {
    const pois = ringOfPois(4, 500, () => ({ openingHours: hours("Mo-Su 10:00-18:00") }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs(),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    expect(result.days[0].warnings).toHaveLength(0);
  });
});

describe("weekday closures (§7c)", () => {
  it("never places a Monday-closed museum on a Monday", () => {
    const pois = clusteredPois(3, 5, 250, 2000, () => ({
      openingHours: hours("Tu-Su 10:00-18:00"),
      category: "major-museum",
      typicalDurationMin: 90,
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 3, startDate: MONDAY }),
      preferences: prefs({ pace: "moderate" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    const monday = result.days.find((d) => weekdayOf(d.date) === 1);
    expect(monday).toBeDefined();
    expect(monday!.stops).toHaveLength(0);
    assertEveryStopIsOpen(result.days, pois);
  });

  it("routes a mixed set around the closed day instead of losing the museums", () => {
    // Six museums shut Mondays, six places open every day, spread over two
    // clusters. A working scheduler puts the always-open cluster on the Monday.
    const museums = clusteredPois(1, 6, 300, 0, () => ({
      openingHours: hours("Tu-Su 10:00-18:00"),
      category: "major-museum",
      score: 9,
    }));
    const always = clusteredPois(1, 6, 300, 3000, () => ({
      openingHours: hours("Mo-Su 09:00-20:00"),
      score: 8,
    }));
    const pois = [...museums, ...always];
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 2, startDate: MONDAY }),
      preferences: prefs({ pace: "moderate" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });

    const monday = result.days.find((d) => weekdayOf(d.date) === 1)!;
    const tuesday = result.days.find((d) => weekdayOf(d.date) === 2)!;
    expect(monday.stops.length).toBeGreaterThan(0);
    const museumIds = new Set(museums.map((m) => m.id));
    expect(monday.stops.some((s) => museumIds.has(s.poiId))).toBe(false);
    expect(tuesday.stops.some((s) => museumIds.has(s.poiId))).toBe(true);
    assertEveryStopIsOpen(result.days, pois);
  });

  it("records the reason when a weekday closure costs a place its slot", () => {
    const pois = ringOfPois(5, 400, () => ({ openingHours: hours("Tu-Su 10:00-18:00") }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs(),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    expect(result.dropped.length).toBe(5);
    expect(result.dropped[0].reason).toBe("Closed Mondays");
  });

  it("handles a two-day closure across a week-long stay", () => {
    const pois = clusteredPois(7, 4, 250, 2000, (c) => ({
      openingHours: hours(c % 2 === 0 ? "We-Su 10:00-18:00" : "Mo-Su 10:00-19:00"),
      score: 9 - c * 0.1,
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 7, startDate: MONDAY }),
      preferences: prefs({ pace: "moderate" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    assertEveryStopIsOpen(result.days, pois);
    for (const day of result.days) {
      const weekday = weekdayOf(day.date);
      for (const stop of day.stops) {
        const p = pois.find((x) => x.id === stop.poiId)!;
        if (p.openingHours?.raw.startsWith("We-Su")) {
          expect([1, 2]).not.toContain(weekday);
        }
      }
    }
  });

  it("checks every day of a stay, not only the first", () => {
    const pois = clusteredPois(4, 5, 250, 2000, (c) => ({
      // Each cluster shuts on a different weekday.
      openingHours: hours(["Tu-Su 10:00-18:00", "We-Mo 10:00-18:00", "Th-Tu 10:00-18:00", "Fr-We 10:00-18:00"][c]),
    }));
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 4, startDate: MONDAY }),
      preferences: prefs({ pace: "moderate" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [],
    });
    assertEveryStopIsOpen(result.days, pois);
    for (const day of result.days) {
      const weekday = weekdayOf(day.date)!;
      for (const stop of day.stops) {
        const p = pois.find((x) => x.id === stop.poiId)!;
        const res = resolveHours(p.openingHours, dateForDay(cityStay({ startDate: MONDAY }), day.dayIndex), {
          lat: p.lat,
          lng: p.lng,
        });
        expect(res.kind === "known" && res.windows.length > 0, `weekday ${weekday}`).toBe(true);
      }
    }
  });
});

describe("pinned times (the §8 exception)", () => {
  it("keeps a pinned stop at its pinned time even when the place looks shut", () => {
    const target = poi({ name: "Livraria Lello", openingHours: hours("Mo-Su 09:30-19:00"), score: 9 });
    const others = ringOfPois(4, 600, () => ({ openingHours: hours("Mo-Su 10:00-18:00") }));
    const pois = [target, ...others];
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs({ dayEnd: "late" }),
      travelMatrix: syntheticMatrix(pois),
      pins: [{ poiId: target.id, dayIndex: 0, arriveMin: 20 * 60 }],
    });
    const stop = result.days[0].stops.find((s) => s.poiId === target.id);
    expect(stop).toBeDefined();
    expect(stop!.arriveMin).toBe(20 * 60);
    expect(stop!.pinned).toBe(true);
    // And it must say so rather than pretending the place is open.
    expect(result.days[0].warnings.join(" ")).toMatch(/pinned .*Lello.* closed/i);
  });

  it("does not warn when a pinned time is inside the place's hours", () => {
    const target = poi({ name: "Serralves", openingHours: hours("Mo-Su 10:00-19:00"), score: 9 });
    const pois = [target, ...ringOfPois(3, 500, () => ({ openingHours: hours("Mo-Su 10:00-18:00") }))];
    const result = scheduleCity({
      pois,
      cityStay: cityStay({ days: 1, startDate: MONDAY }),
      preferences: prefs(),
      travelMatrix: syntheticMatrix(pois),
      pins: [{ poiId: target.id, dayIndex: 0, arriveMin: 11 * 60 }],
    });
    expect(result.days[0].warnings.join(" ")).not.toMatch(/pinned/i);
  });
});
