/** Small geodesy helpers shared by clustering, sequencing and the map. */

export type LatLng = { lat: number; lng: number };

export type GeocodeResult = {
  displayName: string;
  cityName: string;
  lat: number;
  lng: number;
  /** ISO 3166-1 alpha-2, used to resolve public-holiday opening rules (§7c). */
  countryCode: string | null;
  /**
   * The place's English exonym when the geocoder knows one. Nominatim answers
   * "Kyoto" with `京都市`, and English Wikivoyage has no article under that
   * title — so without this the entire editorial signal (§5a) is lost for any
   * city whose local name is not its English one.
   */
  englishName: string | null;
};

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dφ = φ2 - φ1;
  const dλ = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Street distance is longer than the crow-flies line. 1.3 is the usual planar
 * detour factor for a European city grid, and it keeps the offline fallback
 * from promising walks that are shorter than the pavement allows.
 */
export const DETOUR_FACTOR = 1.3;

export function walkingDistanceM(a: LatLng, b: LatLng): number {
  return haversineM(a, b) * DETOUR_FACTOR;
}

export function centroid(points: LatLng[]): LatLng {
  if (points.length === 0) return { lat: 0, lng: 0 };
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

/** A bounding box around a centre, given a radius in metres. */
export function bboxAround(
  centre: LatLng,
  radiusM: number,
): { south: number; west: number; north: number; east: number } {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = dLat / Math.max(0.01, Math.cos((centre.lat * Math.PI) / 180));
  return {
    south: centre.lat - dLat,
    west: centre.lng - dLng,
    north: centre.lat + dLat,
    east: centre.lng + dLng,
  };
}
