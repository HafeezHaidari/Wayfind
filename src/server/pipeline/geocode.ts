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
    }));
}

type NominatimResult = {
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  address?: Record<string, string>;
};

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
