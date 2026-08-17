/**
 * §6a — every scoring weight, in one config object with named constants.
 * "They will need tuning, and tuning is impossible when they are scattered."
 *
 * Each term below is computed as a 0-1 value and multiplied by its weight, so
 * the weights are directly comparable: interest match at 10 is worth twice
 * editorial endorsement at 5. Interest match is the dominant term by design.
 *
 * These are not a claim of optimality (§0b). They are a defensible ordering:
 * places the traveller said they wanted, that a knowledgeable human thought
 * worth listing, that are notable, affordable and suited to the group.
 */

export const SCORING_WEIGHTS = {
  /** Does the POI's category intersect the traveller's interests. Dominant term. */
  interestMatch: 10,
  /** A second interest tag also matching is worth something, but far less. */
  interestBreadth: 1.5,
  /** Listed in Wikivoyage at all. */
  editorialListed: 5,
  /** How near the top of its section the editor put it. */
  editorialProminence: 2.5,
  /** How much the editor wrote about it. */
  editorialDepth: 1.5,
  /** Wikidata sitelink count, log-scaled. */
  notability: 3,
  /** POI price tier against the budget preference. */
  priceFit: 2,
  /** Kid-friendliness and accessibility against the group and mobility. */
  groupFit: 2.5,
} as const;

/**
 * §6a crowd handling: when `avoidCrowds` is set, penalise the highest-notability
 * items and boost the mid-notability ones in the same category. The famous thing
 * is famous; the traveller asked for the other one.
 */
export const CROWD = {
  /** Notability above this is "the famous one". */
  highThreshold: 0.62,
  /** Notability inside this band is the quieter equivalent worth surfacing. */
  midBand: [0.2, 0.55] as [number, number],
  penalty: 4,
  boost: 2,
} as const;

/** Sitelink count that counts as fully notable; the scale is logarithmic. */
export const NOTABILITY_SATURATION = 90;

/** Wikivoyage content length, in characters, that counts as a full write-up. */
export const EDITORIAL_DEPTH_SATURATION = 400;

/**
 * Price fit: how well a POI's tier (0 free - 3 expensive) suits each budget.
 * 1 is a good match, 0 a poor one. Nothing is ever forbidden by price alone —
 * a shoestring traveller may still want the one paid thing they came for.
 */
export const PRICE_FIT: Record<string, [number, number, number, number]> = {
  shoestring: [1, 0.8, 0.35, 0.05],
  moderate: [1, 1, 0.75, 0.35],
  comfortable: [0.9, 1, 1, 0.8],
  "no-limit": [0.85, 0.95, 1, 1],
};

/** How much the mobility preference discounts a physically demanding place. */
export const MOBILITY_PENALTY = {
  "lots-of-walking-fine": 0,
  moderate: 0.15,
  "minimal-walking": 0.5,
} as const;

/**
 * §6b job 1 applies a diff from the free-text box. This caps how far a single
 * sentence can move a category weight, so "we like food" cannot silently turn a
 * museum trip into a restaurant crawl.
 */
export const MAX_INTEREST_DELTA = 2;
