import type { InterestTag, Preferences } from "../shared/types.js";
import { CATEGORY_BY_KEY } from "../shared/categories.js";
import {
  CROWD,
  EDITORIAL_DEPTH_SATURATION,
  MOBILITY_PENALTY,
  NOTABILITY_SATURATION,
  PRICE_FIT,
  SCORING_WEIGHTS,
} from "../shared/scoring-config.js";
import type { Candidate } from "../server/pipeline/candidates.js";

/**
 * §6a — deterministic scoring. No AI anywhere in this file: a weighted sum of
 * signals we actually have, in ordinary code, so the same inputs always produce
 * the same ranking and every number can be traced back to a source.
 *
 * The output is not a claim that the top-scoring place is objectively best
 * (§0b). It is an ordering the app can defend and the traveller can override.
 */

export type ScoreBreakdown = {
  total: number;
  interest: number;
  editorial: number;
  notability: number;
  price: number;
  group: number;
  crowd: number;
  /** Which of the traveller's interests this place actually satisfies. */
  matchedTags: InterestTag[];
};

export function scoreCandidates(candidates: Candidate[], preferences: Preferences): Candidate[] {
  for (const candidate of candidates) {
    const breakdown = scoreCandidate(candidate, preferences);
    candidate.poi.score = round(breakdown.total);
    candidate.breakdown = breakdown;
  }
  return candidates.sort((a, b) => b.poi.score - a.poi.score);
}

export function scoreCandidate(candidate: Candidate, preferences: Preferences): ScoreBreakdown {
  const { poi, signals } = candidate;

  // --- interest match, the dominant term ------------------------------------
  const levels = poi.tags.map((tag) => preferences.interests[tag] ?? 1);
  const matchedTags = poi.tags.filter((tag) => (preferences.interests[tag] ?? 1) > 1);
  const best = levels.length > 0 ? Math.max(...levels) : 1;
  const breadth =
    levels.length > 1 ? levels.filter((l) => l >= 2).length / levels.length : 0;
  const interest =
    (best / 3) * SCORING_WEIGHTS.interestMatch + breadth * SCORING_WEIGHTS.interestBreadth;

  // --- editorial endorsement -------------------------------------------------
  let editorial = 0;
  if (signals.editorialListed) {
    editorial += SCORING_WEIGHTS.editorialListed;
    if (signals.editorialOrder !== null && signals.editorialTotal > 0) {
      const prominence = 1 - signals.editorialOrder / signals.editorialTotal;
      editorial += prominence * SCORING_WEIGHTS.editorialProminence;
    }
    editorial +=
      Math.min(1, signals.editorialContentLength / EDITORIAL_DEPTH_SATURATION) *
      SCORING_WEIGHTS.editorialDepth;
  }

  // --- notability, log-scaled -----------------------------------------------
  const notabilityRatio = normalisedNotability(signals.sitelinks);
  const notability = notabilityRatio * SCORING_WEIGHTS.notability;

  // --- price fit -------------------------------------------------------------
  const tier = poi.priceTier ?? 1;
  const priceRow = PRICE_FIT[preferences.budget] ?? PRICE_FIT.moderate;
  const price = priceRow[tier] * SCORING_WEIGHTS.priceFit;

  // --- group fit -------------------------------------------------------------
  const group = groupFit(candidate, preferences) * SCORING_WEIGHTS.groupFit;

  // --- crowd handling --------------------------------------------------------
  let crowd = 0;
  if (preferences.avoidCrowds) {
    if (notabilityRatio >= CROWD.highThreshold) {
      crowd -= CROWD.penalty * notabilityRatio;
    } else if (notabilityRatio >= CROWD.midBand[0] && notabilityRatio <= CROWD.midBand[1]) {
      crowd += CROWD.boost;
    }
  }

  const total = interest + editorial + notability + price + group + crowd;
  return {
    total,
    interest: round(interest),
    editorial: round(editorial),
    notability: round(notability),
    price: round(price),
    group: round(group),
    crowd: round(crowd),
    matchedTags,
  };
}

/** Sitelinks are heavily skewed, so a log scale is the only readable one. */
export function normalisedNotability(sitelinks: number): number {
  if (sitelinks <= 0) return 0;
  return Math.min(1, Math.log1p(sitelinks) / Math.log1p(NOTABILITY_SATURATION));
}

function groupFit(candidate: Candidate, preferences: Preferences): number {
  const { poi, signals } = candidate;
  const category = poi.category ? CATEGORY_BY_KEY[poi.category] : null;
  let fit = 0.5; // neutral

  const withKids = preferences.travellingWith === "kids" || preferences.travellingWith === "family-mixed";
  if (withKids && category) {
    fit += category.kidFit * 0.3;
    if (signals.kidFriendly === true) fit += 0.2;
  }

  // Accessibility where it is tagged, against the mobility preference.
  const penalty = MOBILITY_PENALTY[preferences.mobility];
  if (penalty > 0) {
    if (signals.wheelchair === "yes") fit += 0.25;
    else if (signals.wheelchair === "no") fit -= penalty;
    // Sprawling outdoor sites are a lot of ground to cover.
    if (category && !category.indoor && category.durationMin >= 90) fit -= penalty * 0.5;
  }

  return clamp01(fit);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
