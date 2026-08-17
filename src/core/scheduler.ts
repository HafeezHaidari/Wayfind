import type {
  CityStay,
  DroppedCandidate,
  ItineraryDay,
  MealSlot,
  Pin,
  Poi,
  Preferences,
  TravelMatrix,
  ScheduledStop,
} from "../shared/types.js";
import type { LatLng } from "../shared/geo.js";
import { dateForDay, formatClock, weekdayName, weekdayOf } from "../shared/dates.js";
import {
  ABSOLUTE_MIN_STOP_MIN,
  BUFFER_BETWEEN_STOPS_MIN,
  DAILY_WALK_CAP_M,
  DAY_END_MIN,
  DAY_START_MIN,
  DINNER_DURATION_MIN,
  DINNER_WINDOW,
  LUNCH_DURATION_MIN,
  LUNCH_WINDOW,
  MIN_DURATION_FRACTION,
  NAMED_MEAL_MIN_IMPORTANCE,
  OVERSELECT_FACTOR,
  PACE_TARGETS,
} from "../shared/planning-config.js";
import { clusterByGeography } from "./cluster.js";
import { sequenceStops } from "./sequence.js";
import { BASECAMP_ID, travelMinutes, walkingLoadM } from "./travel.js";
import {
  closedAllDay,
  closedWeekdays,
  earliestFit,
  needsWarning,
  resolveHours,
  warningFor,
  type HoursResolution,
} from "./hours.js";

/**
 * §7 — the scheduler. A pure function: no network, no AI, no clock reads
 * beyond the dates it is given. Everything it needs arrives as an argument, so
 * it is fully unit-testable over synthetic POIs and a synthetic travel matrix,
 * which is why §0d builds it before the data layer.
 *
 * Opening hours are a hard constraint here, never a scoring penalty (§7c). The
 * single exception is a stop the user pinned to a specific time: §8 says a pin
 * is never moved or dropped, so the scheduler honours it and attaches a warning
 * rather than silently overruling the traveller. See DOCUMENTATION.md.
 */

export type ScheduleInput = {
  /** Ranked candidates for this city (§6). Order is irrelevant; `score` is not. */
  pois: Poi[];
  cityStay: CityStay;
  preferences: Preferences;
  /** Computed once per city per generation (§5d). Null falls back to estimates. */
  travelMatrix: TravelMatrix | null;
  pins: Pin[];
  /**
   * A tighter daily walking cap than the mobility preference implies, when the
   * free-text note asked for one (§6b job 1 -> src/core/apply-diff.ts).
   */
  walkCapOverrideM?: number | null;
};

export type ScheduleResult = {
  days: ItineraryDay[];
  /** Meal breaks per day index (§7b). Kept beside the stops because an unnamed
   *  break has no POI, and every `ScheduledStop` must trace to a real POI. */
  meals: Record<number, MealSlot[]>;
  /** What did not fit, and why, for the alternatives panel (§7a step 6, §9e). */
  dropped: DroppedCandidate[];
};

export function scheduleCity(input: ScheduleInput): ScheduleResult {
  const { pois, cityStay, preferences, travelMatrix, pins } = input;
  const byId = new Map(pois.map((p) => [p.id, p]));
  const dayCount = Math.max(1, Math.round(cityStay.days));
  const basecamp = basecampOf(cityStay);
  const dropped: DroppedCandidate[] = [];

  const cost = (a: string, b: string) =>
    travelMinutes(
      travelMatrix,
      a,
      b,
      locationOf(a, byId, basecamp, cityStay),
      locationOf(b, byId, basecamp, cityStay),
      preferences.transport,
    );

  const { sights, mealVenues } = splitPools(pois, preferences);
  const pinnedIds = new Set(pins.map((p) => p.poiId));

  // --- §7a step 1: select, over-selecting so the layout has room to drop -----
  const perDay = paceMid(preferences.pace);
  const budget = Math.ceil(perDay * dayCount * OVERSELECT_FACTOR);
  const ranked = [...sights].sort((a, b) => b.score - a.score);
  const selected = ranked.filter((p) => pinnedIds.has(p.id)).concat(
    ranked.filter((p) => !pinnedIds.has(p.id)).slice(0, Math.max(0, budget - pinnedIds.size)),
  );
  for (const poi of ranked.slice(budget)) {
    if (pinnedIds.has(poi.id)) continue;
    dropped.push({
      poiId: poi.id,
      reason: "Ranked below the places that made the plan",
      dayIndex: null,
      score: poi.score,
    });
  }

  // --- §7a steps 2 and 3: cluster, then map clusters onto days --------------
  const dayPinned = new Map<number, Poi[]>();
  for (const pin of pins) {
    if (pin.dayIndex === null) continue;
    const poi = byId.get(pin.poiId);
    if (!poi) continue;
    const day = Math.min(dayCount - 1, Math.max(0, pin.dayIndex));
    dayPinned.set(day, [...(dayPinned.get(day) ?? []), poi]);
  }
  const pinnedToDay = new Set([...dayPinned.values()].flat().map((p) => p.id));
  const clusterable = selected.filter((p) => !pinnedToDay.has(p.id));

  const { assignment } = clusterByGeography({
    points: clusterable.map((p) => ({ lat: p.lat, lng: p.lng })),
    k: dayCount,
    basecamp,
  });
  const clusters: Poi[][] = Array.from({ length: dayCount }, () => []);
  clusterable.forEach((poi, i) => {
    const cluster = assignment[i] ?? 0;
    clusters[Math.min(cluster, dayCount - 1)].push(poi);
  });

  const clusterForDay = assignClustersToDays(clusters, cityStay, dayCount, dayPinned, cost);

  // --- §7a steps 4 to 6: sequence, lay out, drop what does not fit ----------
  const days: ItineraryDay[] = [];
  const meals: Record<number, MealSlot[]> = {};
  const usedMealVenues = new Set<string>();
  const usedPoiIds = new Set<string>();

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
    const date = dateForDay(cityStay, dayIndex);
    const cluster = clusters[clusterForDay[dayIndex]] ?? [];
    const dayPois = [...(dayPinned.get(dayIndex) ?? []), ...cluster];

    const laid = layOutDay({
      dayIndex,
      date,
      pois: dayPois,
      byId,
      preferences,
      pins,
      basecamp,
      cityStay,
      travelMatrix,
      cost,
      walkCapM: walkCap(preferences, input.walkCapOverrideM),
      mealVenues: mealVenues.filter((v) => !usedMealVenues.has(v.id)),
    });

    for (const slot of laid.meals) if (slot.poiId) usedMealVenues.add(slot.poiId);
    for (const stop of laid.stops) usedPoiIds.add(stop.poiId);

    days.push({ dayIndex, cityName: cityStay.cityName, date, stops: laid.stops, warnings: laid.warnings });
    meals[dayIndex] = laid.meals;
    dropped.push(...laid.dropped);
  }

  // --- Fill thin days from what is left over --------------------------------
  const target = PACE_TARGETS[preferences.pace];
  const leftovers = () =>
    selected
      .filter((p) => !usedPoiIds.has(p.id))
      .sort((a, b) => b.score - a.score);

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
    if (days[dayIndex].stops.length >= target.min) continue;
    for (const candidate of leftovers()) {
      const attemptPois = [
        ...days[dayIndex].stops.map((s) => byId.get(s.poiId)!).filter(Boolean),
        candidate,
      ];
      const laid = layOutDay({
        dayIndex,
        date: days[dayIndex].date,
        pois: attemptPois,
        byId,
        preferences,
        pins,
        basecamp,
        cityStay,
        travelMatrix,
        cost,
        walkCapM: walkCap(preferences, input.walkCapOverrideM),
        mealVenues: mealVenues.filter((v) => !usedMealVenues.has(v.id) || isUsedBy(meals[dayIndex], v.id)),
      });
      if (laid.stops.length > days[dayIndex].stops.length) {
        for (const stop of laid.stops) usedPoiIds.add(stop.poiId);
        days[dayIndex] = {
          dayIndex,
          cityName: cityStay.cityName,
          date: days[dayIndex].date,
          stops: laid.stops,
          warnings: laid.warnings,
        };
        meals[dayIndex] = laid.meals;
        for (const slot of laid.meals) if (slot.poiId) usedMealVenues.add(slot.poiId);
      }
      if (days[dayIndex].stops.length >= target.min) break;
    }
  }

  // Anything selected that never landed anywhere is an alternative, not a
  // silent disappearance (§9e).
  const placed = new Set(days.flatMap((d) => d.stops.map((s) => s.poiId)));
  const alreadyDropped = new Set(dropped.map((d) => d.poiId));
  for (const poi of selected) {
    if (placed.has(poi.id) || alreadyDropped.has(poi.id)) continue;
    dropped.push({
      poiId: poi.id,
      reason: "No room left in these days",
      dayIndex: null,
      score: poi.score,
    });
  }

  return { days, meals, dropped: dedupeDropped(dropped, placed) };
}

// --- day layout ---------------------------------------------------------------

type LayOutArgs = {
  dayIndex: number;
  date: string | null;
  pois: Poi[];
  byId: Map<string, Poi>;
  preferences: Preferences;
  pins: Pin[];
  basecamp: LatLng | null;
  cityStay: CityStay;
  travelMatrix: TravelMatrix | null;
  cost: (a: string, b: string) => number;
  walkCapM: number;
  mealVenues: Poi[];
};

type LaidDay = {
  stops: ScheduledStop[];
  meals: MealSlot[];
  warnings: string[];
  dropped: DroppedCandidate[];
};

function layOutDay(args: LayOutArgs): LaidDay {
  const { dayIndex, date, pois, preferences, pins, basecamp, cityStay, travelMatrix, cost } = args;
  const dayStart = DAY_START_MIN[preferences.dayStart];
  const dayEnd = DAY_END_MIN[preferences.dayEnd];
  const walkCapMetres = args.walkCapM;
  const paceMax = PACE_TARGETS[preferences.pace].max;

  const stops: ScheduledStop[] = [];
  const meals: MealSlot[] = [];
  const warnings: string[] = [];
  const dropped: DroppedCandidate[] = [];

  const pinFor = (id: string) => pins.find((p) => p.poiId === id) ?? null;
  const country = cityStay.countryCode ?? null;
  const hoursFor = (poi: Poi) =>
    resolveHours(poi.openingHours, date, { lat: poi.lat, lng: poi.lng, countryCode: country });

  // Places that are shut all day never reach the sequencer (§7c step 3).
  const openToday: Poi[] = [];
  for (const poi of pois) {
    const res = hoursFor(poi);
    if (closedAllDay(res) && !pinFor(poi.id)?.arriveMin) {
      dropped.push({
        poiId: poi.id,
        reason: closedReason(date),
        dayIndex,
        score: poi.score,
      });
      continue;
    }
    openToday.push(poi);
  }

  const timePinned = openToday
    .filter((p) => pinFor(p.id)?.arriveMin != null)
    .sort((a, b) => (pinFor(a.id)!.arriveMin ?? 0) - (pinFor(b.id)!.arriveMin ?? 0));

  const sequence = sequenceStops(
    openToday.map((p) => p.id),
    cost,
    {
      startId: basecamp ? BASECAMP_ID : null,
      fixedOrder: timePinned.map((p) => p.id),
    },
  );

  const poiById = new Map(openToday.map((p) => [p.id, p]));
  let cursorMin = dayStart;
  let cursorId: string | null = basecamp ? BASECAMP_ID : null;
  let cursorAt: LatLng = basecamp ?? { lat: cityStay.lat, lng: cityStay.lng };
  let walkedM = 0;
  const mealsPlaced = { lunch: false, dinner: false };
  // Lunch and dinner draw from the same pool, so a venue used at midday must
  // not turn up again at eight.
  const venuesUsedToday = new Set<string>();

  const placeMealIfDue = (kind: "lunch" | "dinner", projectedEnd: number) => {
    if (mealsPlaced[kind]) return;
    const window = kind === "lunch" ? LUNCH_WINDOW : DINNER_WINDOW;
    const duration =
      kind === "lunch"
        ? LUNCH_DURATION_MIN[preferences.foodImportance]
        : DINNER_DURATION_MIN[preferences.foodImportance];
    if (cursorMin > window.latest) {
      // Overdue — eat now rather than at 16:00 (§7b).
    } else if (cursorMin < window.earliest) {
      return;
    } else if (projectedEnd <= window.latest) {
      return; // the next stop still lands inside the window; eat after it
    }
    const slot = placeMeal(kind, duration);
    if (slot) meals.push(slot);
  };

  const placeMeal = (kind: "lunch" | "dinner", duration: number): MealSlot | null => {
    const startFrom = Math.max(cursorMin, kind === "lunch" ? LUNCH_WINDOW.earliest : DINNER_WINDOW.earliest);
    if (startFrom + duration > dayEnd) {
      mealsPlaced[kind] = true; // no room today; do not keep retrying
      return null;
    }
    const named =
      preferences.foodImportance >= NAMED_MEAL_MIN_IMPORTANCE
        ? pickMealVenue(args, startFrom, duration, cursorId, cursorAt, dayEnd, date, venuesUsedToday)
        : null;

    mealsPlaced[kind] = true;
    if (named) {
      venuesUsedToday.add(named.poi.id);
      cursorMin = named.startMin + duration;
      cursorId = named.poi.id;
      cursorAt = { lat: named.poi.lat, lng: named.poi.lng };
      walkedM += named.walkM;
      const res = hoursFor(named.poi);
      if (needsWarning(res)) {
        const text = warningFor(res, named.poi.name);
        if (text) warnings.push(text);
      }
      return { kind, startMin: named.startMin, durationMin: duration, poiId: named.poi.id };
    }
    cursorMin = startFrom + duration;
    return { kind, startMin: startFrom, durationMin: duration, poiId: null };
  };

  for (const id of sequence) {
    const poi = poiById.get(id);
    if (!poi) continue;
    const pin = pinFor(id);

    if (stops.length >= paceMax && !pin) {
      dropped.push({
        poiId: id,
        reason: `Day is already full at your ${preferences.pace} pace`,
        dayIndex,
        score: poi.score,
      });
      continue;
    }

    const buffer = stops.length > 0 ? BUFFER_BETWEEN_STOPS_MIN : 0;
    const projectedEnd =
      cursorMin + (cursorId ? cost(cursorId, id) : 0) + buffer + poi.typicalDurationMin;

    // A meal goes in before the stop that would otherwise swallow the window.
    placeMealIfDue("lunch", projectedEnd);
    placeMealIfDue("dinner", projectedEnd);

    // Eating may have moved both the clock and where we are standing.
    const travel = cursorId ? cost(cursorId, id) : 0;
    const arriveFrom = cursorMin + travel + buffer;

    const res = hoursFor(poi);
    const floor = durationFloor(poi);

    let arrive: number | null = null;
    let duration = poi.typicalDurationMin;

    if (pin?.arriveMin != null) {
      // §8: a pinned time is never moved. If the place looks shut then, say so
      // rather than quietly overriding the traveller (see the module header).
      arrive = pin.arriveMin;
      if (arrive + duration > dayEnd) duration = Math.max(floor, dayEnd - arrive);
    } else {
      arrive = earliestFit(res, arriveFrom, duration, dayEnd);
      if (arrive === null && floor < duration) {
        duration = floor;
        arrive = earliestFit(res, arriveFrom, duration, dayEnd);
      }
    }

    if (arrive === null) {
      dropped.push({
        poiId: id,
        reason: noFitReason(res, arriveFrom, poi.typicalDurationMin, dayEnd),
        dayIndex,
        score: poi.score,
      });
      continue;
    }

    const walkAdd = cursorId
      ? walkingLoadM(travelMatrix, cursorId, id, cursorAt, poi, preferences.transport)
      : 0;
    if (walkedM + walkAdd > walkCapMetres && !pin) {
      dropped.push({
        poiId: id,
        reason: "Would push the day past the walking you asked for",
        dayIndex,
        score: poi.score,
      });
      continue;
    }

    stops.push({
      poiId: id,
      arriveMin: arrive,
      departMin: arrive + duration,
      travelFromPrevMin: stops.length === 0 && !basecamp ? 0 : Math.round(travel),
      pinned: pin !== null,
      rationale: poi.rationale,
    });

    if (needsWarning(res)) {
      const text = warningFor(res, poi.name);
      if (text) warnings.push(text);
    }
    if (pin?.arriveMin != null && !fitsAt(res, arrive, arrive + duration)) {
      warnings.push(
        `You pinned ${poi.name} to ${formatClock(arrive)}, but it looks closed then — worth checking.`,
      );
    }

    walkedM += walkAdd;
    cursorMin = arrive + duration;
    cursorId = id;
    cursorAt = { lat: poi.lat, lng: poi.lng };
  }

  // A day that ran out of stops before the meal windows still needs feeding.
  if (!mealsPlaced.lunch && cursorMin <= LUNCH_WINDOW.latest) {
    const slot = placeMeal("lunch", LUNCH_DURATION_MIN[preferences.foodImportance]);
    if (slot) meals.push(slot);
  }
  if (!mealsPlaced.dinner && cursorMin <= DINNER_WINDOW.latest) {
    const slot = placeMeal("dinner", DINNER_DURATION_MIN[preferences.foodImportance]);
    if (slot) meals.push(slot);
  }

  stops.sort((a, b) => a.arriveMin - b.arriveMin);
  meals.sort((a, b) => a.startMin - b.startMin);

  if (date === null && stops.length > 0) {
    warnings.push(
      "No dates set for this city, so weekday closures haven't been checked. Add dates for a firmer plan.",
    );
  }

  return { stops, meals, warnings: dedupe(warnings), dropped };
}

// --- helpers -----------------------------------------------------------------

function splitPools(pois: Poi[], preferences: Preferences): { sights: Poi[]; mealVenues: Poi[] } {
  const sights: Poi[] = [];
  const mealVenues: Poi[] = [];
  for (const poi of pois) {
    // Restaurants and cafés are held back for meal slots (§7b) so a day does
    // not spend a "sight" on lunch and then schedule lunch as well. Markets
    // stay sights: a market is somewhere you go, not only somewhere you eat.
    if (poi.category === "restaurant" || poi.category === "cafe") mealVenues.push(poi);
    else if (hasWantedTag(poi, preferences)) sights.push(poi);
  }
  return {
    sights,
    mealVenues: mealVenues.sort((a, b) => b.score - a.score),
  };
}

function hasWantedTag(poi: Poi, preferences: Preferences): boolean {
  if (poi.tags.length === 0) return true; // user-added places have no tags
  return poi.tags.some((tag) => (preferences.interests[tag] ?? 1) > 0);
}

/** The mobility preference's cap, tightened by any free-text override (§6b). */
function walkCap(preferences: Preferences, override: number | null | undefined): number {
  const base = DAILY_WALK_CAP_M[preferences.mobility];
  return typeof override === "number" && override > 0 ? Math.min(base, override) : base;
}

function paceMid(pace: Preferences["pace"]): number {
  const t = PACE_TARGETS[pace];
  return (t.min + t.max) / 2;
}

function basecampOf(stay: CityStay): LatLng | null {
  return stay.basecampLat !== null && stay.basecampLng !== null
    ? { lat: stay.basecampLat, lng: stay.basecampLng }
    : null;
}

function locationOf(
  id: string,
  byId: Map<string, Poi>,
  basecamp: LatLng | null,
  stay: CityStay,
): LatLng {
  if (id === BASECAMP_ID) return basecamp ?? { lat: stay.lat, lng: stay.lng };
  const poi = byId.get(id);
  return poi ? { lat: poi.lat, lng: poi.lng } : { lat: stay.lat, lng: stay.lng };
}

/** §7d — never shrink a stop into a token visit to make the arithmetic work. */
function durationFloor(poi: Poi): number {
  return Math.max(
    ABSOLUTE_MIN_STOP_MIN,
    Math.round(poi.typicalDurationMin * MIN_DURATION_FRACTION),
  );
}

function fitsAt(res: HoursResolution, arrive: number, depart: number): boolean {
  if (res.kind === "unknown") return true;
  return res.windows.some((w) => arrive >= w.openMin && depart <= w.closeMin);
}

function closedReason(date: string | null): string {
  const day = weekdayName(date);
  return day ? `Closed ${day}s` : "Closed on this day";
}

function noFitReason(
  res: HoursResolution,
  arriveFrom: number,
  duration: number,
  dayEnd: number,
): string {
  if (res.kind !== "unknown" && res.windows.length > 0) {
    const last = res.windows[res.windows.length - 1];
    if (arriveFrom + duration > last.closeMin) {
      return `Closes at ${formatClock(last.closeMin)}, before you'd get there`;
    }
    if (arriveFrom < res.windows[0].openMin) {
      return `Doesn't open until ${formatClock(res.windows[0].openMin)}`;
    }
  }
  if (arriveFrom + duration > dayEnd) return "No time left before the end of the day";
  return "Didn't fit the day's route";
}

/**
 * The best-scoring unused meal venue that is actually open, preferring nearby
 * ones so lunch does not mean a twenty-minute detour.
 */
function pickMealVenue(
  args: LayOutArgs,
  startFrom: number,
  duration: number,
  cursorId: string | null,
  cursorAt: LatLng,
  dayEnd: number,
  date: string | null,
  usedToday: Set<string>,
): { poi: Poi; startMin: number; walkM: number } | null {
  const shortlist = args.mealVenues.filter((v) => !usedToday.has(v.id)).slice(0, 25);
  let best: { poi: Poi; startMin: number; walkM: number; cost: number } | null = null;

  for (const venue of shortlist) {
    const travel = cursorId ? args.cost(cursorId, venue.id) : 0;
    const res = resolveHours(venue.openingHours, date, {
      lat: venue.lat,
      lng: venue.lng,
      countryCode: args.cityStay.countryCode ?? null,
    });
    if (closedAllDay(res)) continue;
    const start = earliestFit(res, startFrom + travel, duration, dayEnd);
    if (start === null) continue;
    // Rank on how much of the day it costs, nudged by score: a slightly better
    // restaurant is worth five minutes, not twenty-five.
    const rank = travel + (start - startFrom) - venue.score * 6;
    if (!best || rank < best.cost) {
      best = {
        poi: venue,
        startMin: start,
        walkM: cursorId
          ? walkingLoadM(
              args.travelMatrix,
              cursorId,
              venue.id,
              cursorAt,
              venue,
              args.preferences.transport,
            )
          : 0,
        cost: rank,
      };
    }
  }
  return best ? { poi: best.poi, startMin: best.startMin, walkM: best.walkM } : null;
}

/**
 * §7a step 3 — map each day onto a cluster, keeping POIs off the weekday they
 * are shut. Days are few, so a greedy assignment plus exhaustive pairwise swaps
 * gets to a good answer without a full Hungarian solver.
 */
function assignClustersToDays(
  clusters: Poi[][],
  cityStay: CityStay,
  dayCount: number,
  dayPinned: Map<number, Poi[]>,
  cost: (a: string, b: string) => number,
): number[] {
  const penalty: number[][] = [];
  for (let day = 0; day < dayCount; day++) {
    const date = dateForDay(cityStay, day);
    const weekday = weekdayOf(date);
    const pinnedHere = dayPinned.get(day) ?? [];
    penalty[day] = clusters.map((cluster) => {
      let p = 0;
      if (weekday !== null) {
        for (const poi of cluster) {
          const shut = closedWeekdays(poi.openingHours, {
            lat: poi.lat,
            lng: poi.lng,
            countryCode: cityStay.countryCode ?? null,
          });
          // Losing a high-scoring place to a weekday closure is the cost we are
          // trying to avoid, so the penalty is that place's score.
          if (shut.includes(weekday)) p += Math.max(1, poi.score);
        }
      }
      // Keep a cluster near whatever the user pinned to that day.
      for (const pinned of pinnedHere) {
        for (const poi of cluster) p += cost(pinned.id, poi.id) / Math.max(1, cluster.length) / 30;
      }
      return p;
    });
  }

  const assignment = Array.from({ length: dayCount }, (_, i) => i);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let a = 0; a < dayCount; a++) {
      for (let b = a + 1; b < dayCount; b++) {
        const now = penalty[a][assignment[a]] + penalty[b][assignment[b]];
        const swapped = penalty[a][assignment[b]] + penalty[b][assignment[a]];
        if (swapped < now - 1e-9) {
          [assignment[a], assignment[b]] = [assignment[b], assignment[a]];
          improved = true;
        }
      }
    }
  }
  return assignment;
}

function isUsedBy(meals: MealSlot[] | undefined, poiId: string): boolean {
  return (meals ?? []).some((m) => m.poiId === poiId);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** One entry per place, and never one for something that ended up scheduled. */
function dedupeDropped(dropped: DroppedCandidate[], placed: Set<string>): DroppedCandidate[] {
  const seen = new Map<string, DroppedCandidate>();
  for (const d of dropped) {
    if (placed.has(d.poiId)) continue;
    if (!seen.has(d.poiId)) seen.set(d.poiId, d);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}
