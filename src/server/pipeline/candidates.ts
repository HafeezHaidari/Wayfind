import type { InterestTag, Poi } from "../../shared/types.js";
import type { ListingKind } from "./wikivoyage.js";
import type { ScoreBreakdown } from "../../core/rank.js";

/**
 * A candidate is a POI plus the raw signals ranking will weigh (§6a). The
 * signals stay on the server: the client receives `Poi` objects with a final
 * score and rationale, not the working notes behind them.
 */
export type RankingSignals = {
  /** Listed in Wikivoyage at all — the editorial endorsement of §6a. */
  editorialListed: boolean;
  editorialKind: ListingKind | null;
  /** Position within the article; earlier is more prominent. */
  editorialOrder: number | null;
  editorialTotal: number;
  /** How much an editor wrote about it, a proxy for how much they cared. */
  editorialContentLength: number;
  /** Wikidata sitelink count (§5a). */
  sitelinks: number;
  /** OSM tags that inform group fit and price, kept for scoring only. */
  wheelchair: string | null;
  kidFriendly: boolean | null;
  feeFree: boolean | null;
  /** True when the place came from Wikivoyage without an OSM counterpart. */
  editorialOnly: boolean;
};

export type Candidate = {
  poi: Poi;
  signals: RankingSignals;
  /** Filled in by scoring (§6a); kept server-side for tuning and rationale. */
  breakdown?: ScoreBreakdown;
};

export function emptySignals(): RankingSignals {
  return {
    editorialListed: false,
    editorialKind: null,
    editorialOrder: null,
    editorialTotal: 0,
    editorialContentLength: 0,
    sitelinks: 0,
    wheelchair: null,
    kidFriendly: null,
    feeFree: null,
    editorialOnly: false,
  };
}

/** The interest tags a set of candidates can actually satisfy. */
export function tagsCovered(candidates: Candidate[]): Set<InterestTag> {
  const out = new Set<InterestTag>();
  for (const c of candidates) for (const tag of c.poi.tags) out.add(tag);
  return out;
}
