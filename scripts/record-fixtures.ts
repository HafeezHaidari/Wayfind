/**
 * Records the live responses §11a asks for, so the whole pipeline can run with
 * no network and no keys.
 *
 * These are recordings, not stand-ins: FIXTURE_MODE swaps only the transport.
 * Every parsing, matching, ranking and scheduling step downstream is the same
 * code that runs against live data (§11c).
 *
 *   npm run record-fixtures -- "Porto"
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CATEGORIES } from "../src/shared/categories.js";
import { defaultPreferences } from "../src/shared/preferences.js";
import type { CityStay } from "../src/shared/types.js";
import { Counters } from "../src/server/pipeline/counters.js";
import { geocodeCity } from "../src/server/pipeline/geocode.js";
import { queryOverpass, type OverpassResponse } from "../src/server/pipeline/overpass.js";
import { fetchWikivoyageArticle, parseListings, isVisitable } from "../src/server/pipeline/wikivoyage.js";
import { fetchSitelinkCounts } from "../src/server/pipeline/wikidata.js";
import { assembleCandidates } from "../src/server/pipeline/sourcing.js";
import { scoreCandidates } from "../src/core/rank.js";
import { buildTravelMatrix, MAX_MATRIX_POINTS } from "../src/server/pipeline/osrm.js";
import { fixtureSlug } from "../src/server/pipeline/fixtures.js";
import { BASECAMP_ID } from "../src/core/travel.js";

const cityName = process.argv[2] ?? "Porto";

async function main() {
  if (process.env.FIXTURE_MODE === "true") {
    throw new Error("Turn FIXTURE_MODE off to record fixtures — it would record the fixtures.");
  }

  const slug = fixtureSlug(cityName);
  const dir = join(process.cwd(), "fixtures", slug);
  await mkdir(dir, { recursive: true });
  const counters = new Counters();

  console.log(`[1/6] locating ${cityName}…`);
  const located = (await geocodeCity(cityName))[0];
  if (!located) throw new Error(`Nominatim doesn't know ${cityName}.`);
  const city: CityStay = {
    cityName: located.cityName,
    lat: located.lat,
    lng: located.lng,
    startDate: null,
    days: 3,
    basecampLat: null,
    basecampLng: null,
    countryCode: located.countryCode,
    englishName: located.englishName,
  };
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify(
      {
        city: located.cityName,
        centre: { lat: located.lat, lng: located.lng },
        countryCode: located.countryCode,
        englishName: located.englishName,
        recordedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.log("[2/6] fetching the Wikivoyage article…");
  const article = await fetchWikivoyageArticle(
    [located.englishName ?? "", located.cityName],
    counters,
  );
  if (!article) throw new Error(`No Wikivoyage article for ${located.cityName}.`);
  await writeFile(join(dir, "wikivoyage.wikitext"), article);
  const listings = parseListings(article).filter(isVisitable);
  console.log(`      ${listings.length} listings parsed`);

  // Record every category, so a fixture serves any interest profile; the
  // per-generation filter happens downstream in assembleCandidates.
  console.log("[3/6] querying Overpass (one batched query, this is slow)…");
  const overpass: OverpassResponse = await queryOverpass(
    { lat: city.lat, lng: city.lng },
    CATEGORIES.filter((c) => c.overpass.length > 0),
    counters,
  );
  await writeFile(join(dir, "overpass.json"), JSON.stringify(overpass));
  console.log(`      ${overpass.elements.length} elements`);

  console.log("[4/6] assembling candidates and fetching Wikidata sitelinks…");
  const { candidates } = await assembleCandidates({
    city,
    centre: { lat: city.lat, lng: city.lng },
    listings,
    overpass,
    categories: CATEGORIES,
    counters,
  });
  const wikidataIds = candidates
    .map((c) => c.poi.sourceIds.wikidata)
    .filter((id): id is string => typeof id === "string");
  const sitelinks = await fetchSitelinkCounts(wikidataIds, counters, located.cityName);
  await writeFile(join(dir, "wikidata.json"), JSON.stringify(sitelinks, null, 2));
  console.log(`      ${candidates.length} candidates, ${Object.keys(sitelinks).length} sitelink counts`);

  console.log("[5/6] building the travel matrix…");
  const ranked = scoreCandidates(candidates, defaultPreferences());
  const points = ranked
    .slice(0, MAX_MATRIX_POINTS - 1)
    .map((c) => ({ id: c.poi.id, lat: c.poi.lat, lng: c.poi.lng }));
  points.unshift({ id: BASECAMP_ID, lat: city.lat, lng: city.lng });
  const matrix = await buildTravelMatrix(points, "walk", counters, located.cityName);
  await writeFile(join(dir, "matrix.json"), JSON.stringify(matrix));
  console.log(`      ${Object.keys(matrix.durations).length} pairs`);

  console.log("[6/6] recording expected ranking output…");
  await writeFile(
    join(dir, "expected-ranking.json"),
    JSON.stringify(
      {
        preferences: "defaults",
        recordedAt: new Date().toISOString(),
        top: ranked.slice(0, 30).map((c) => ({
          id: c.poi.id,
          name: c.poi.name,
          category: c.poi.category,
          score: c.poi.score,
          breakdown: c.breakdown,
          editorialListed: c.signals.editorialListed,
          sitelinks: c.signals.sitelinks,
          hasHours: c.poi.openingHours !== null,
        })),
      },
      null,
      2,
    ),
  );

  console.log(`\nDone. fixtures/${slug}/ recorded.`);
  console.log(counters.snapshot());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
