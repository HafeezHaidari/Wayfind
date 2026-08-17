import type { CityStay } from "./types.js";

/** Date and clock helpers. Minutes-from-midnight is the app's time unit (§3). */

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The ISO date of day `index` of a stay, or null when the stay has no dates. */
export function dateForDay(stay: CityStay, index: number): string | null {
  if (!stay.startDate) return null;
  const t = Date.parse(stay.startDate);
  if (Number.isNaN(t)) return null;
  return toISODate(new Date(t + index * 86_400_000));
}

export function toISODate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 0 = Sunday. Null when the date is unknown. */
export function weekdayOf(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getDay();
}

export function weekdayName(isoDate: string | null): string | null {
  const wd = weekdayOf(isoDate);
  return wd === null ? null : WEEKDAY_NAMES[wd];
}

/** "09:30". Times are data and are always rendered in the mono spine (§9b). */
export function formatClock(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "1 hr 45 min", "40 min" — traveller-facing durations (§9g). */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  const hourPart = `${hours} hr`;
  return rest === 0 ? hourPart : `${hourPart} ${rest} min`;
}

/** "Tue 8 Sep" */
export function formatDayLabel(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
