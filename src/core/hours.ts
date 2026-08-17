import OpeningHoursLib from "opening_hours";
import type { OpeningHours } from "../shared/types.js";
import { CLOSING_MARGIN_MIN } from "../shared/planning-config.js";

/**
 * §7c — opening hours, the thing that breaks naive planners.
 *
 * OSM `opening_hours` is a real grammar with a published specification, so this
 * module delegates to the reference parser rather than attempting a regex. What
 * it adds on top is the shape the scheduler actually needs: for a given date,
 * the concrete minute windows a POI is open, and the earliest start at or after
 * a given time that fits a visit of a given length entirely inside one of them.
 *
 * The rules the rest of the app depends on:
 *   - hours known and closed at the proposed time  -> NOT schedulable (hard)
 *   - hours unknown (null tag, or a tag we cannot parse) -> schedulable, but
 *     the day must carry a warning naming the place
 *   - state explicitly "unknown" in the grammar     -> treated as open, warned
 */

export type OpenWindow = { openMin: number; closeMin: number };

export type HoursResolution =
  /** No usable hours. Schedulable, but the day carries a warning (§7c). */
  | { kind: "unknown"; reason: "missing" | "unparseable"; uncertain: true }
  /** Hours resolved for a specific calendar date. A hard constraint. */
  | { kind: "known"; windows: OpenWindow[]; uncertain: boolean }
  /**
   * The stay has no dates, so the weekday is unknown. Windows are a typical
   * week's, used for layout only; weekday closures cannot be checked and the
   * day says so.
   */
  | { kind: "undated"; windows: OpenWindow[]; uncertain: boolean };

const MINUTES_PER_DAY = 1440;

/** Where a POI is, and — when known — which country's holidays apply to it. */
export type HoursContext = { lat: number; lng: number; countryCode?: string | null };

/** Parsing is the expensive part; the same tag recurs across a candidate set. */
const parseCache = new Map<string, ParsedHours | null>();

type ParsedHours = {
  lib: InstanceType<typeof OpeningHoursLib>;
  /** True when holiday rules had to be dropped to evaluate the value at all. */
  holidaysDropped: boolean;
};

/**
 * `PH` (public holiday) clauses are common in OSM — "Tu-Su 10:00-18:00; PH off"
 * is an ordinary museum. The parser can only evaluate them when it knows which
 * country's holiday table to use, and throws otherwise. Treating that throw as
 * "closed" silently deleted a large share of every city's real museums, so:
 * parse with the country when we have it, and when we do not, fall back to the
 * same value with its holiday rules removed and flag the result uncertain.
 */
function parse(raw: string, at: HoursContext): ParsedHours | null {
  const country = (at.countryCode ?? "").toLowerCase();
  const key = `${raw}@@${at.lat.toFixed(2)},${at.lng.toFixed(2)}@@${country}`;
  const hit = parseCache.get(key);
  if (hit !== undefined) return hit;

  const result =
    build(raw, at, country, false) ??
    (hasHolidayRule(raw) ? build(stripHolidayRules(raw), at, country, true) : null);

  parseCache.set(key, result);
  return result;
}

function build(
  raw: string,
  at: HoursContext,
  country: string,
  holidaysDropped: boolean,
): ParsedHours | null {
  try {
    // The library wants a Nominatim-shaped location for sunrise/sunset and
    // public-holiday rules.
    const lib = new OpeningHoursLib(raw, {
      lat: at.lat,
      lon: at.lng,
      address: { country_code: country, state: "" },
    } as never);
    // Constructing succeeds for holiday rules even without a country table;
    // it is evaluation that throws, so evaluate once here to find out.
    lib.getState(new Date("2024-01-09T12:00:00"));
    return { lib, holidaysDropped };
  } catch {
    return null; // Unparseable, or unevaluable: §7c says warn, not crash.
  }
}

const HOLIDAY_RULE = /\b(PH|SH)\b/;

function hasHolidayRule(raw: string): boolean {
  return HOLIDAY_RULE.test(raw);
}

/**
 * Drop the rule parts that mention public or school holidays, keeping the
 * ordinary weekly schedule. "Mo-Fr 09:00-17:00; PH off" becomes
 * "Mo-Fr 09:00-17:00" — right on any ordinary day, and the day carries a
 * warning so nobody treats it as verified on a holiday.
 */
export function stripHolidayRules(raw: string): string {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !HOLIDAY_RULE.test(part))
    .join("; ");
}

/**
 * Resolve a POI's hours for one calendar day.
 *
 * @param hours the POI's opening hours, or null when the source had none
 * @param isoDate the day being scheduled, or null when the stay has no dates
 * @param at coordinates, needed for sunset-relative and holiday rules
 */
export function resolveHours(
  hours: OpeningHours | null,
  isoDate: string | null,
  at: HoursContext,
): HoursResolution {
  if (!hours || !hours.raw.trim()) {
    return { kind: "unknown", reason: "missing", uncertain: true };
  }
  const parsed = parse(hours.raw, at);
  if (!parsed) return { kind: "unknown", reason: "unparseable", uncertain: true };

  if (isoDate) {
    const day = startOfDay(isoDate);
    if (!day) return { kind: "unknown", reason: "unparseable", uncertain: true };
    const { windows, uncertain } = windowsOn(parsed, day);
    return { kind: "known", windows, uncertain: uncertain || parsed.holidaysDropped };
  }

  const typical = typicalWeekWindows(parsed);
  return {
    kind: "undated",
    windows: typical.windows,
    uncertain: typical.uncertain || parsed.holidaysDropped,
  };
}

/** True when the POI cannot be visited at all on this date. */
export function closedAllDay(res: HoursResolution): boolean {
  return res.kind !== "unknown" && res.windows.length === 0;
}

/** True when the day must carry a warning naming this stop (§7c, §9d). */
export function needsWarning(res: HoursResolution): boolean {
  return res.kind === "unknown" || res.uncertain || res.kind === "undated";
}

/** Traveller-facing warning text (§9g). */
export function warningFor(res: HoursResolution, placeName: string): string | null {
  if (res.kind === "unknown") {
    return res.reason === "missing"
      ? `Hours unconfirmed for ${placeName} — check before you go.`
      : `Hours for ${placeName} couldn't be read reliably — check before you go.`;
  }
  if (res.uncertain) {
    return `${placeName} may not keep the hours listed — check before you go.`;
  }
  if (res.kind === "undated") {
    return `${placeName}'s hours vary by day, and this city has no dates set, so weekday closures haven't been checked.`;
  }
  return null;
}

/**
 * The earliest minute at or after `fromMin` at which a visit of `durationMin`
 * fits entirely inside an open window, or null if it does not fit today.
 *
 * This is the primitive the timeline layout (§7a step 5) is built on, and it is
 * what makes the opening-hours rule a hard constraint rather than a penalty.
 */
export function earliestFit(
  res: HoursResolution,
  fromMin: number,
  durationMin: number,
  dayEndMin: number,
): number | null {
  if (res.kind === "unknown") {
    // Hours unknown: schedulable anywhere in the day, with a warning attached.
    return fromMin + durationMin <= dayEndMin ? fromMin : null;
  }
  for (const w of res.windows) {
    const start = Math.max(fromMin, w.openMin);
    const end = start + durationMin;
    if (end <= Math.min(w.closeMin, dayEndMin) && end <= dayEndMin) return start;
  }
  return null;
}

/** True when [arriveMin, departMin] lies inside a single open window. */
export function fitsWithinHours(
  res: HoursResolution,
  arriveMin: number,
  departMin: number,
): boolean {
  if (res.kind === "unknown") return true; // unverified, not violated
  return res.windows.some((w) => arriveMin >= w.openMin && departMin <= w.closeMin);
}

/**
 * How much of the visit would be cut short by closing time. Used only to
 * prefer a comfortable slot over a rushed one; it never overrides the hard
 * constraint above.
 */
export function closingPressure(res: HoursResolution, departMin: number): number {
  if (res.kind === "unknown") return 0;
  const window = res.windows.find((w) => departMin <= w.closeMin && departMin >= w.openMin);
  if (!window) return 0;
  return Math.max(0, CLOSING_MARGIN_MIN - (window.closeMin - departMin));
}

/** The weekdays (0 = Sunday) on which the POI is shut all day. */
export function closedWeekdays(hours: OpeningHours | null, at: HoursContext): number[] {
  if (!hours) return [];
  const parsed = parse(hours.raw, at);
  if (!parsed) return [];
  const out: number[] = [];
  for (const day of sampleWeek()) {
    if (windowsOn(parsed, day).windows.length === 0) out.push(day.getDay());
  }
  return out;
}

// --- internals ---------------------------------------------------------------

function startOfDay(isoDate: string): Date | null {
  const d = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Walk the library's state iterator across one local day and collect the
 * intervals during which it reports open (or explicitly unknown, which the OSM
 * grammar allows and which we surface as uncertainty rather than hiding).
 */
function windowsOn(
  parsed: ParsedHours,
  dayStart: Date,
): { windows: OpenWindow[]; uncertain: boolean } {
  const dayEnd = new Date(dayStart.getTime() + MINUTES_PER_DAY * 60_000);
  const windows: OpenWindow[] = [];
  let uncertain = false;

  try {
    const it = parsed.lib.getIterator(dayStart);
    let open = it.getState();
    let unknown = it.getUnknown();
    let cursor = dayStart;
    let guard = 0;

    while (it.advance(dayEnd) && guard++ < 64) {
      const at = it.getDate();
      if (open || unknown) {
        pushWindow(windows, minutesInto(dayStart, cursor), minutesInto(dayStart, at));
        if (unknown) uncertain = true;
      }
      open = it.getState();
      unknown = it.getUnknown();
      cursor = at;
    }
    if (open || unknown) {
      pushWindow(windows, minutesInto(dayStart, cursor), MINUTES_PER_DAY);
      if (unknown) uncertain = true;
    }
  } catch {
    // A rule that parses but throws while evaluating (holiday tables, mostly).
    return { windows: [], uncertain: true };
  }

  return { windows: mergeWindows(windows), uncertain };
}

/**
 * A representative week's hours, for stays with no dates. The median weekday by
 * open minutes is used rather than the union: the union would claim a place is
 * open on the day it shuts, which is exactly the failure §7c is about.
 */
function typicalWeekWindows(parsed: ParsedHours): { windows: OpenWindow[]; uncertain: boolean } {
  const perDay = sampleWeek().map((d) => windowsOn(parsed, d));
  const openMinutes = perDay.map((r) => totalOpenMinutes(r.windows));
  const ranked = perDay
    .map((r, i) => ({ r, minutes: openMinutes[i] }))
    .sort((a, b) => a.minutes - b.minutes);
  const median = ranked[Math.floor(ranked.length / 2)];
  return {
    windows: median.r.windows,
    uncertain: perDay.some((r) => r.uncertain) || new Set(openMinutes).size > 1,
  };
}

/**
 * A fixed reference week, so results do not shift with today's date. Starts on
 * Sunday 2024-01-07 and runs seven days; seasonal rules resolve against it
 * consistently, which is all a dateless stay can honestly claim.
 */
function sampleWeek(): Date[] {
  const base = new Date("2024-01-07T00:00:00");
  return Array.from({ length: 7 }, (_, i) => new Date(base.getTime() + i * 86_400_000));
}

function minutesInto(dayStart: Date, at: Date): number {
  const mins = Math.round((at.getTime() - dayStart.getTime()) / 60_000);
  return Math.max(0, Math.min(MINUTES_PER_DAY, mins));
}

function pushWindow(into: OpenWindow[], openMin: number, closeMin: number) {
  if (closeMin > openMin) into.push({ openMin, closeMin });
}

function mergeWindows(windows: OpenWindow[]): OpenWindow[] {
  if (windows.length <= 1) return windows;
  const sorted = [...windows].sort((a, b) => a.openMin - b.openMin);
  const out: OpenWindow[] = [sorted[0]];
  for (const w of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (w.openMin <= last.closeMin) last.closeMin = Math.max(last.closeMin, w.closeMin);
    else out.push({ ...w });
  }
  return out;
}

function totalOpenMinutes(windows: OpenWindow[]): number {
  return windows.reduce((sum, w) => sum + (w.closeMin - w.openMin), 0);
}
