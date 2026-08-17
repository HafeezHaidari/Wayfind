import { describe, expect, it } from "vitest";
import {
  closedAllDay,
  closedWeekdays,
  earliestFit,
  fitsWithinHours,
  needsWarning,
  resolveHours,
  stripHolidayRules,
  warningFor,
} from "../src/core/hours.js";
import type { OpeningHours } from "../src/shared/types.js";

const PORTO = { lat: 41.1496, lng: -8.6109 };
const osm = (raw: string): OpeningHours => ({ raw, source: "osm" });

// 2026-09-07 is a Monday; the week that follows is used throughout.
const MONDAY = "2026-09-07";
const TUESDAY = "2026-09-08";
const SATURDAY = "2026-09-12";
const SUNDAY = "2026-09-13";

describe("resolveHours", () => {
  it("reads a simple daily window", () => {
    const res = resolveHours(osm("Mo-Su 10:00-18:00"), MONDAY, PORTO);
    expect(res).toMatchObject({ kind: "known", windows: [{ openMin: 600, closeMin: 1080 }] });
  });

  it("reads split hours as two windows, not one long one", () => {
    const res = resolveHours(osm("Mo-Fr 09:00-12:00,14:00-18:00"), MONDAY, PORTO);
    expect(res.kind).toBe("known");
    if (res.kind !== "known") return;
    expect(res.windows).toEqual([
      { openMin: 540, closeMin: 720 },
      { openMin: 840, closeMin: 1080 },
    ]);
  });

  it("treats 24/7 as open all day", () => {
    const res = resolveHours(osm("24/7"), MONDAY, PORTO);
    expect(res).toMatchObject({ kind: "known", windows: [{ openMin: 0, closeMin: 1440 }] });
  });

  it("reports a weekday closure as closed all day", () => {
    // The classic case: a museum shut on Mondays.
    const res = resolveHours(osm("Tu-Su 10:00-18:00"), MONDAY, PORTO);
    expect(closedAllDay(res)).toBe(true);
    expect(closedAllDay(resolveHours(osm("Tu-Su 10:00-18:00"), TUESDAY, PORTO))).toBe(false);
  });

  it("honours an explicit off rule that overrides an earlier range", () => {
    const hours = osm("Mo-Su 10:00-19:00; Mo off");
    expect(closedAllDay(resolveHours(hours, MONDAY, PORTO))).toBe(true);
    expect(closedAllDay(resolveHours(hours, TUESDAY, PORTO))).toBe(false);
  });

  it("resolves seasonal rules against the actual date", () => {
    const hours = osm("Apr-Sep: Mo-Su 09:00-20:00; Oct-Mar: Mo-Su 09:00-18:00");
    const september = resolveHours(hours, "2026-09-07", PORTO);
    const january = resolveHours(hours, "2026-01-07", PORTO);
    expect(september).toMatchObject({ windows: [{ openMin: 540, closeMin: 1200 }] });
    expect(january).toMatchObject({ windows: [{ openMin: 540, closeMin: 1080 }] });
  });

  it("handles weekend-only hours", () => {
    const hours = osm("Sa,Su 11:00-16:00");
    expect(closedAllDay(resolveHours(hours, MONDAY, PORTO))).toBe(true);
    expect(resolveHours(hours, SATURDAY, PORTO)).toMatchObject({
      windows: [{ openMin: 660, closeMin: 960 }],
    });
    expect(resolveHours(hours, SUNDAY, PORTO)).toMatchObject({
      windows: [{ openMin: 660, closeMin: 960 }],
    });
  });

  it("marks a missing tag unknown rather than guessing", () => {
    const res = resolveHours(null, MONDAY, PORTO);
    expect(res).toMatchObject({ kind: "unknown", reason: "missing" });
    expect(needsWarning(res)).toBe(true);
    expect(warningFor(res, "Casa da Música")).toContain("Casa da Música");
  });

  it("marks an unparseable tag unknown rather than crashing", () => {
    const res = resolveHours(osm("whenever the owner feels like it"), MONDAY, PORTO);
    expect(res.kind).toBe("unknown");
    expect(needsWarning(res)).toBe(true);
  });

  it("surfaces the grammar's explicit unknown state as uncertainty", () => {
    const res = resolveHours(osm('Mo-Su 10:00-18:00; Su "ring the bell"'), SUNDAY, PORTO);
    expect(needsWarning(res)).toBe(true);
  });

  it("falls back to a typical week when the stay has no dates", () => {
    const res = resolveHours(osm("Tu-Su 10:00-18:00"), null, PORTO);
    expect(res.kind).toBe("undated");
    // A place shut one day a week cannot be verified without dates, so the day
    // must say so rather than quietly assuming it is open.
    expect(needsWarning(res)).toBe(true);
  });

  it("does not warn about an undated stay when hours never vary", () => {
    const res = resolveHours(osm("24/7"), null, PORTO);
    expect(res.kind).toBe("undated");
    expect(res).toMatchObject({ uncertain: false });
  });
});

describe("earliestFit", () => {
  const openTenToSix = resolveHours(osm("Mo-Su 10:00-18:00"), MONDAY, PORTO);

  it("pushes an early arrival to opening time", () => {
    expect(earliestFit(openTenToSix, 8 * 60, 60, 22 * 60)).toBe(600);
  });

  it("keeps a mid-window arrival where it is", () => {
    expect(earliestFit(openTenToSix, 13 * 60, 60, 22 * 60)).toBe(780);
  });

  it("refuses a visit that would run past closing", () => {
    expect(earliestFit(openTenToSix, 17 * 60 + 30, 60, 22 * 60)).toBeNull();
  });

  it("skips a closed gap to the next window", () => {
    const split = resolveHours(osm("Mo-Fr 09:00-12:00,14:00-18:00"), MONDAY, PORTO);
    expect(earliestFit(split, 12 * 60 + 30, 90, 22 * 60)).toBe(840);
  });

  it("will not schedule a visit that cannot fit any window", () => {
    const split = resolveHours(osm("Mo-Fr 09:00-12:00,14:00-18:00"), MONDAY, PORTO);
    expect(earliestFit(split, 9 * 60, 5 * 60, 22 * 60)).toBeNull();
  });

  it("respects the day's own end time", () => {
    expect(earliestFit(openTenToSix, 10 * 60, 120, 11 * 60)).toBeNull();
  });

  it("places an unknown-hours POI wherever it fits in the day", () => {
    const unknown = resolveHours(null, MONDAY, PORTO);
    expect(earliestFit(unknown, 9 * 60, 60, 22 * 60)).toBe(540);
    expect(earliestFit(unknown, 21 * 60 + 30, 60, 22 * 60)).toBeNull();
  });
});

describe("fitsWithinHours", () => {
  const res = resolveHours(osm("Mo-Su 10:00-18:00"), MONDAY, PORTO);

  it("accepts a visit inside the window", () => {
    expect(fitsWithinHours(res, 660, 720)).toBe(true);
  });

  it("rejects a visit starting before opening", () => {
    expect(fitsWithinHours(res, 540, 660)).toBe(false);
  });

  it("rejects a visit ending after closing", () => {
    expect(fitsWithinHours(res, 1020, 1140)).toBe(false);
  });

  it("rejects a visit spanning a midday closure", () => {
    const split = resolveHours(osm("Mo-Fr 09:00-12:00,14:00-18:00"), MONDAY, PORTO);
    expect(fitsWithinHours(split, 660, 900)).toBe(false);
  });
});

describe("closedWeekdays", () => {
  it("finds the weekday a museum shuts", () => {
    expect(closedWeekdays(osm("Tu-Su 10:00-18:00"), PORTO)).toEqual([1]);
  });

  it("finds a two-day closure", () => {
    expect(closedWeekdays(osm("We-Su 10:00-18:00"), PORTO).sort()).toEqual([1, 2]);
  });

  it("reports none for a place always open", () => {
    expect(closedWeekdays(osm("24/7"), PORTO)).toEqual([]);
  });

  it("reports none when hours are unknown", () => {
    expect(closedWeekdays(null, PORTO)).toEqual([]);
  });
});

describe("public-holiday rules (the PH trap)", () => {
  // "Tu-Su 10:00-18:00; PH off" is an ordinary museum, and the reference parser
  // throws on it unless it knows the country. Treating that throw as "closed"
  // silently deleted a large share of every city's real museums.
  const withPH = osm("Tu-Su 10:00-18:00; PH off");

  it("resolves normally when the country is known", () => {
    const res = resolveHours(withPH, TUESDAY, { ...PORTO, countryCode: "pt" });
    expect(res).toMatchObject({ kind: "known", windows: [{ openMin: 600, closeMin: 1080 }] });
    expect(closedAllDay(res)).toBe(false);
  });

  it("still resolves without a country, by dropping the holiday clause", () => {
    const res = resolveHours(withPH, TUESDAY, PORTO);
    expect(closedAllDay(res)).toBe(false);
    expect(res).toMatchObject({ kind: "known", windows: [{ openMin: 600, closeMin: 1080 }] });
  });

  it("marks a holiday-stripped reading as unverified", () => {
    expect(needsWarning(resolveHours(withPH, TUESDAY, PORTO))).toBe(true);
    expect(needsWarning(resolveHours(withPH, TUESDAY, { ...PORTO, countryCode: "pt" }))).toBe(false);
  });

  it("keeps the weekday closure when the holiday clause is dropped", () => {
    expect(closedAllDay(resolveHours(withPH, MONDAY, PORTO))).toBe(true);
  });

  it("handles a holiday clause that grants hours rather than removing them", () => {
    const res = resolveHours(
      osm("Mo-Fr 09:00-17:00; Sa,Su,PH 10:00-19:00"),
      TUESDAY,
      PORTO,
    );
    expect(res).toMatchObject({ kind: "known", windows: [{ openMin: 540, closeMin: 1020 }] });
  });

  it("strips only the holiday parts", () => {
    expect(stripHolidayRules("Mo-Fr 09:00-17:00; PH off")).toBe("Mo-Fr 09:00-17:00");
    expect(stripHolidayRules("Tu-Su 10:00-18:00; Jan 01 off; PH 15:00-19:00")).toBe(
      "Tu-Su 10:00-18:00; Jan 01 off",
    );
  });
});
