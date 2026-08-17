import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GeocodeResult } from "../../shared/geo.js";

/**
 * §11a — recorded responses replayed through the real logic. These are not
 * canned outputs: FIXTURE_MODE swaps only the transport, every parsing,
 * matching, ranking and scheduling step downstream is the same code that runs
 * against live data (§11c).
 */

const FIXTURE_ROOT = join(process.cwd(), "fixtures");

export type CityFixture = {
  city: string;
  centre: { lat: number; lng: number };
  countryCode?: string | null;
  recordedAt: string;
};

export function listFixtureCities(): string[] {
  if (!existsSync(FIXTURE_ROOT)) return [];
  return readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(FIXTURE_ROOT, e.name, "meta.json")))
    .map((e) => readMeta(e.name).city);
}

export function fixtureSlug(cityName: string): string {
  return cityName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function hasFixture(cityName: string): boolean {
  return existsSync(join(FIXTURE_ROOT, fixtureSlug(cityName), "meta.json"));
}

export function readMeta(slug: string): CityFixture {
  return readFixture<CityFixture>(slug, "meta.json");
}

export function readFixture<T>(slug: string, file: string): T {
  const path = join(FIXTURE_ROOT, slug, file);
  if (!existsSync(path)) {
    throw new Error(
      `FIXTURE_MODE is on but fixtures/${slug}/${file} is missing. ` +
        `Record it with: npm run record-fixtures -- "<city>"`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readFixtureText(slug: string, file: string): string {
  const path = join(FIXTURE_ROOT, slug, file);
  if (!existsSync(path)) {
    throw new Error(
      `FIXTURE_MODE is on but fixtures/${slug}/${file} is missing. ` +
        `Record it with: npm run record-fixtures -- "<city>"`,
    );
  }
  return readFileSync(path, "utf8");
}

/** In fixture mode the geocoder answers only for cities we have recorded. */
export function fixtureGeocode(query: string): GeocodeResult[] {
  const slug = fixtureSlug(query);
  if (!hasFixture(query)) {
    const known = listFixtureCities();
    throw new Error(
      known.length > 0
        ? `Fixture mode only knows ${known.join(", ")}. Turn off FIXTURE_MODE to plan elsewhere.`
        : "Fixture mode is on but no cities have been recorded yet.",
    );
  }
  const meta = readMeta(slug);
  return [
    {
      displayName: `${meta.city} (recorded fixture)`,
      cityName: meta.city,
      lat: meta.centre.lat,
      lng: meta.centre.lng,
      countryCode: meta.countryCode ?? null,
    },
  ];
}
