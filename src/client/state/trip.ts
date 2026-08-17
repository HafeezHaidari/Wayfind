import type { CityStay, TripBrief } from "../../shared/types.js";
import { defaultPreferences } from "../../shared/preferences.js";

/** A trip lives only in this tab. Closing it loses the trip unless exported (§1). */
export function newTripBrief(): TripBrief {
  return {
    id: crypto.randomUUID(),
    name: "",
    cities: [],
    preferences: defaultPreferences(),
    freeText: null,
  };
}

export function blankCity(): CityStay {
  return {
    cityName: "",
    lat: 0,
    lng: 0,
    startDate: null,
    days: 3,
    basecampLat: null,
    basecampLng: null,
  };
}

/** Inclusive day count between two ISO dates, floored at 1. */
export function daysBetween(startISO: string, endISO: string): number {
  const start = Date.parse(startISO);
  const end = Date.parse(endISO);
  if (Number.isNaN(start) || Number.isNaN(end)) return 1;
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

/** The ISO date of day `index` of a stay, or null when the stay has no dates. */
export function dateForDay(stay: CityStay, index: number): string | null {
  if (!stay.startDate) return null;
  const t = Date.parse(stay.startDate);
  if (Number.isNaN(t)) return null;
  return new Date(t + index * 86_400_000).toISOString().slice(0, 10);
}

export function totalDays(brief: TripBrief): number {
  return brief.cities.reduce((sum, c) => sum + c.days, 0);
}

/** A trip is generatable once it has at least one located city. */
export function isReadyToGenerate(brief: TripBrief): boolean {
  return brief.cities.length > 0 && brief.cities.every((c) => c.cityName.trim() !== "");
}
