import { env, USER_AGENT } from "../env.js";
import { fixtureGeocode } from "./fixtures.js";
import type { GeocodeResult } from "../../shared/geo.js";

/**
 * Nominatim, the free keyless geocoder that comes with OSM. Its usage policy
 * asks for an identifying User-Agent and no more than one request a second;
 * this is a single-user app doing one lookup per typed city, which is well
 * inside that.
 */
export async function geocodeCity(query: string): Promise<GeocodeResult[]> {
  if (env.fixtureMode) return fixtureGeocode(query);

  const url = new URL(`${env.nominatimUrl}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");
  // `name:en` is what makes the Wikivoyage lookup work for non-anglophone cities.
  url.searchParams.set("namedetails", "1");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);

  const raw = (await res.json()) as NominatimResult[];
  return raw
    .filter((r) => r.lat && r.lon)
    .map((r) => ({
      displayName: r.display_name,
      cityName: pickCityName(r, query),
      lat: Number(r.lat),
      lng: Number(r.lon),
      countryCode: r.address?.country_code?.toLowerCase() ?? null,
      englishName: englishNameOf(r),
    }));
}

type NominatimResult = {
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  address?: Record<string, string>;
  namedetails?: Record<string, string>;
};

/** The English exonym, when it differs from the name the geocoder led with. */
function englishNameOf(r: NominatimResult): string | null {
  const english = r.namedetails?.["name:en"]?.trim();
  if (!english) return null;
  return english === r.name?.trim() ? null : english;
}

function pickCityName(r: NominatimResult, fallback: string): string {
  return (
    r.name ||
    r.address?.city ||
    r.address?.town ||
    r.address?.village ||
    r.display_name.split(",")[0]?.trim() ||
    fallback
  );
}
