import type {
  CityItinerary,
  CityStay,
  Itinerary,
  Pin,
  Poi,
  Preferences,
  TripBrief,
} from "../../shared/types.js";
import { CATEGORY_BY_KEY } from "../../shared/categories.js";
import { INTEREST_LABELS } from "../../shared/interests.js";
import { defaultPreferences } from "../../shared/preferences.js";
import { formatDayLabel } from "../../shared/dates.js";
import { scheduleCity } from "../../core/scheduler.js";
import { scoreCandidates } from "../../core/rank.js";
import { applyPreferenceDiff } from "../../core/apply-diff.js";
import { resolveHours, needsWarning, warningFor } from "../../core/hours.js";
import { BASECAMP_ID } from "../../core/travel.js";
import { env } from "../env.js";
import { info, errorAt } from "../log.js";
import { Counters } from "./counters.js";
import { sourceCity } from "./sourcing.js";
import { buildTravelMatrix, estimatedMatrix, MAX_MATRIX_POINTS, type MatrixPoint } from "./osrm.js";
import { interpretFreeText, semanticMatch, writeRationales, applyRationales } from "./llm.js";
import type { Candidate } from "./candidates.js";
import { activeProvider } from "./providers.js";

/**
 * The generation pipeline, in the order §0d builds it:
 *   free text -> preferences (§6b.1)
 *   sourcing (§5) -> ranking (§6a) -> travel matrix (§5d) -> scheduling (§7)
 *   -> rationale (§6c)
 *
 * The server is stateless: nothing here is written to disk or kept between
 * requests except the third-party POI cache §5e permits.
 */

export type GenerateRequest = {
  brief: TripBrief;
  pins: Pin[];
  reuseCandidates: boolean;
  /** Places the traveller took out of the plan (§8). Never re-offered. */
  removedPoiIds: string[];
};

/** How much of a boost a semantic match earns. Enough to win its slot, not enough to distort the day. */
const SEMANTIC_MATCH_BOOST = 8;

export async function generateItinerary(body: unknown): Promise<Itinerary> {
  const request = validateRequest(body);
  const counters = new Counters();
  const notes: string[] = [];

  // §6b job 1 — the free-text box becomes a diff, applied deterministically.
  const diff = await interpretFreeText(
    request.brief.freeText,
    request.brief.preferences,
    counters,
  );
  const applied = applyPreferenceDiff(request.brief.preferences, diff);
  notes.push(...applied.notes);

  const cities: CityItinerary[] = [];
  const pois: Record<string, Poi> = {};

  for (const city of request.brief.cities) {
    const result = await planCity({
      city,
      preferences: applied.preferences,
      removedPoiIds: new Set(request.removedPoiIds),
      walkCapOverrideM: applied.walkCapOverrideM,
      specialRequests: diff.specialRequests,
      pins: request.pins,
      counters,
    });
    cities.push(result.itinerary);
    notes.push(...result.notes);
    for (const poi of result.pois) pois[poi.id] = poi;
  }

  counters.report(request.brief.cities.map((c) => c.cityName).join(", "));

  return {
    briefId: request.brief.id,
    cities,
    pois,
    counters: counters.snapshot(),
    notes: [...new Set(notes)],
  };
}

async function planCity(input: {
  city: CityStay;
  preferences: Preferences;
  walkCapOverrideM: number | null;
  specialRequests: { descriptor: string; slot: "lunch" | "dinner" | "any"; dayIndex: number | null }[];
  pins: Pin[];
  removedPoiIds: Set<string>;
  counters: Counters;
}): Promise<{ itinerary: CityItinerary; pois: Poi[]; notes: string[] }> {
  const { city, preferences, counters } = input;
  const notes: string[] = [];

  // --- §5: source candidates -------------------------------------------------
  const sourced = await sourceCity(city, preferences, counters);
  notes.push(...sourced.notes);

  if (sourced.candidates.length === 0) {
    // §9g: say what went wrong and what to do about it.
    throw new Error(
      `No places found for these interests in ${city.cityName} — try widening your interests, ` +
        `or check the city name is right.`,
    );
  }

  // --- §6a: deterministic scoring -------------------------------------------
  const provider = activeProvider();
  if (provider.available()) {
    await provider.enrich(sourced.candidates, { lat: city.lat, lng: city.lng });
  }
  const ranked = scoreCandidates(sourced.candidates, preferences);

  // --- §6b job 2: semantic matching for what tags cannot express -------------
  for (const request of input.specialRequests) {
    const pool = poolFor(ranked, request.slot);
    const chosen = await semanticMatch(request.descriptor, pool.slice(0, 40), 1, counters);
    for (const id of chosen) {
      const candidate = ranked.find((c) => c.poi.id === id);
      if (!candidate) continue;
      candidate.poi.score += SEMANTIC_MATCH_BOOST;
      notes.push(`Worked "${request.descriptor}" into the plan: ${candidate.poi.name}.`);
    }
  }

  // §8: a removed stop stays removed until the traveller says otherwise.
  const pois = ranked
    .map((c) => c.poi)
    .filter((p) => !input.removedPoiIds.has(p.id))
    .sort((a, b) => b.score - a.score);

  // --- §5d: one travel matrix per city per generation ------------------------
  const matrixPoints = matrixPointsFor(pois, city);
  let travelMatrix = null;
  try {
    travelMatrix = await buildTravelMatrix(matrixPoints, preferences.transport, counters, city.cityName);
  } catch (err) {
    // §12: report the degradation, do not switch to a paid router.
    errorAt("travel matrix", err);
    travelMatrix = estimatedMatrix(matrixPoints, preferences.transport);
    notes.push(
      "The routing service didn't answer, so travel times are straight-line estimates. Allow extra.",
    );
  }
  if (travelMatrix.approximate && preferences.transport === "transit") {
    notes.push("Transit times are estimates, not timetabled journeys — check locally before you rely on one.");
  }

  // --- §7: schedule ----------------------------------------------------------
  const scheduled = scheduleCity({
    pois,
    cityStay: city,
    preferences,
    travelMatrix,
    pins: input.pins,
    walkCapOverrideM: input.walkCapOverrideM,
  });

  // --- §6c: rationale, batched one call per day, cosmetic -------------------
  const byId = new Map(pois.map((p) => [p.id, p]));
  const signalsById = new Map(ranked.map((c) => [c.poi.id, c]));
  const days = [];
  for (const day of scheduled.days) {
    const rationales = env.enableRationale
      ? await writeRationales(
          city.cityName,
          formatDayLabel(day.date) ?? `Day ${day.dayIndex + 1}`,
          day.stops.map((stop) =>
            rationaleInputFor(stop, byId, signalsById, day.date, city.countryCode ?? null),
          ),
          counters,
        )
      : {};
    days.push({ ...day, stops: applyRationales(day.stops, rationales) });
  }

  return {
    itinerary: {
      cityName: city.cityName,
      days,
      meals: scheduled.meals,
      dropped: scheduled.dropped,
    },
    pois,
    notes,
  };
}

// --- helpers -----------------------------------------------------------------

function poolFor(ranked: Candidate[], slot: "lunch" | "dinner" | "any"): Poi[] {
  const meals = slot === "any" ? null : new Set(["restaurant", "cafe"]);
  return ranked
    .filter((c) => (meals ? c.poi.category && meals.has(c.poi.category) : true))
    .map((c) => c.poi);
}

/**
 * The matrix covers the candidates the scheduler is actually likely to use,
 * plus the basecamp. OSRM's public table service caps coordinates per request,
 * and asking for every café in Porto would be both rejected and rude (§10).
 */
function matrixPointsFor(pois: Poi[], city: CityStay): MatrixPoint[] {
  const points: MatrixPoint[] = [];
  if (city.basecampLat !== null && city.basecampLng !== null) {
    points.push({ id: BASECAMP_ID, lat: city.basecampLat, lng: city.basecampLng });
  }
  for (const poi of pois) {
    if (points.length >= MAX_MATRIX_POINTS) break;
    points.push({ id: poi.id, lat: poi.lat, lng: poi.lng });
  }
  return points;
}

function rationaleInputFor(
  stop: { poiId: string; arriveMin: number; departMin: number },
  byId: Map<string, Poi>,
  signalsById: Map<string, Candidate>,
  date: string | null,
  countryCode: string | null,
) {
  const poi = byId.get(stop.poiId);
  const candidate = signalsById.get(stop.poiId);
  const hours = poi
    ? resolveHours(poi.openingHours, date, { lat: poi.lat, lng: poi.lng, countryCode })
    : null;
  return {
    id: stop.poiId,
    name: poi?.name ?? stop.poiId,
    category: poi?.category ? CATEGORY_BY_KEY[poi.category].label : "place",
    arriveMin: stop.arriveMin,
    durationMin: stop.departMin - stop.arriveMin,
    matchedInterests: (candidate?.breakdown?.matchedTags ?? []).map((t) => INTEREST_LABELS[t]),
    editorialListed: candidate?.signals.editorialListed ?? false,
    hoursNote:
      hours && poi && needsWarning(hours) ? warningFor(hours, poi.name) : hoursNote(hours),
  };
}

function hoursNote(hours: ReturnType<typeof resolveHours> | null): string | null {
  if (!hours || hours.kind === "unknown" || hours.windows.length === 0) return null;
  const last = hours.windows[hours.windows.length - 1];
  return `open until ${Math.floor(last.closeMin / 60)}:${String(last.closeMin % 60).padStart(2, "0")}`;
}

/** The server trusts nothing it is sent; a malformed brief fails loudly (§11c). */
function validateRequest(body: unknown): GenerateRequest {
  const raw = body as Partial<GenerateRequest> | null;
  const brief = raw?.brief;
  if (!brief || typeof brief !== "object") {
    throw new Error("That request didn't include a trip. Reload and try again.");
  }
  if (!Array.isArray(brief.cities) || brief.cities.length === 0) {
    throw new Error("Add a city to start planning.");
  }
  for (const city of brief.cities) {
    if (!city.cityName?.trim()) throw new Error("One of the cities has no name.");
    if (!Number.isFinite(city.lat) || !Number.isFinite(city.lng) || (city.lat === 0 && city.lng === 0)) {
      throw new Error(
        `Wayfind doesn't know where ${city.cityName} is. Use "Find" on the trip screen to locate it.`,
      );
    }
    if (!Number.isFinite(city.days) || city.days < 1) {
      throw new Error(`${city.cityName} needs at least one day.`);
    }
  }

  info("generating", {
    cities: brief.cities.length,
    days: brief.cities.reduce((sum, c) => sum + c.days, 0),
    pins: raw?.pins?.length ?? 0,
  });

  return {
    brief: {
      ...brief,
      id: brief.id ?? "trip",
      name: brief.name ?? "",
      preferences: { ...defaultPreferences(), ...(brief.preferences ?? {}) },
      freeText: brief.freeText ?? null,
    } as TripBrief,
    pins: Array.isArray(raw?.pins) ? raw.pins : [],
    reuseCandidates: raw?.reuseCandidates === true,
    removedPoiIds: Array.isArray(raw?.removedPoiIds)
      ? raw.removedPoiIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}
