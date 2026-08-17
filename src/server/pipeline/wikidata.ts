import { fetchJson } from "./http.js";
import type { Counters } from "./counters.js";
import { env } from "../env.js";
import { readFixture, fixtureSlug } from "./fixtures.js";

/**
 * §5a — Wikidata sitelink count as a notability proxy. A place written up in
 * thirty language editions is, for our purposes, more significant than one
 * written up in two. Free, keyless, and batched fifty entities at a time.
 */

export type SitelinkCounts = Record<string, number>;

const BATCH_SIZE = 50;

export async function fetchSitelinkCounts(
  ids: string[],
  counters: Counters,
  cityName: string,
): Promise<SitelinkCounts> {
  const unique = [...new Set(ids.filter((id) => /^Q\d+$/.test(id)))];
  if (unique.length === 0) return {};

  if (env.fixtureMode) {
    counters.wikidataFetches += 1;
    try {
      return readFixture<SitelinkCounts>(fixtureSlug(cityName), "wikidata.json");
    } catch {
      return {};
    }
  }

  const out: SitelinkCounts = {};
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const url =
      "https://www.wikidata.org/w/api.php?" +
      new URLSearchParams({
        action: "wbgetentities",
        ids: batch.join("|"),
        props: "sitelinks",
        format: "json",
        formatversion: "2",
      }).toString();

    counters.wikidataFetches += 1;
    const body = await fetchJson<{
      entities?: Record<string, { sitelinks?: Record<string, unknown> }>;
    }>(url, { label: "Wikidata", timeoutMs: 30_000 });

    for (const [id, entity] of Object.entries(body.entities ?? {})) {
      out[id] = Object.keys(entity.sitelinks ?? {}).length;
    }
  }
  return out;
}
