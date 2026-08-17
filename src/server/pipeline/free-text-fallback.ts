import type { HardConstraint, InterestTag, PreferenceDiff } from "../../shared/types.js";
import { MAX_INTEREST_DELTA } from "../../shared/scoring-config.js";

/**
 * The deterministic reading of the free-text box, used when no LLM key is set
 * (§0c: the app must be complete and correct, needing only keys to run live).
 *
 * This is deliberately conservative. It catches the phrases that actually recur
 * — a mobility limit, one nice dinner, "we love markets" — and stays silent on
 * everything else. Being crude and honest beats guessing: a wrong reading here
 * quietly reshapes the whole trip.
 */

type Rule = { pattern: RegExp; apply: (diff: PreferenceDiff, match: RegExpMatchArray) => void };

const INTEREST_PHRASES: [RegExp, InterestTag, number][] = [
  [/\b(museum|museums|gallery|galleries)\b/i, "museums", 1],
  [/\b(art|contemporary art|street art)\b/i, "art", 1],
  [/\b(histor\w+|ruins|ancient)\b/i, "history", 1],
  [/\b(architect\w+|buildings?)\b/i, "architecture", 1],
  [/\b(nature|countryside|hiking|hike|walks in the)\b/i, "nature", 1],
  [/\b(parks?|gardens?)\b/i, "parks", 1],
  [/\b(views?|viewpoints?|lookout|panorama)\b/i, "viewpoints", 1],
  [/\b(beach|beaches|swim\w*)\b/i, "beaches", 1],
  [/\b(markets?|food market|flea market)\b/i, "markets", 1],
  [/\b(caf[eé]s?|coffee)\b/i, "cafes", 1],
  [/\b(nightlife|bars?|clubbing|going out at night)\b/i, "nightlife", 1],
  [/\b(shopping|shops?|boutiques?)\b/i, "shopping", 1],
  [/\b(churches?|cathedrals?|temples?|mosques?|synagogues?)\b/i, "religious-sites", 1],
  [/\b(offbeat|unusual|quirky|hidden gems?|off the beaten)\b/i, "offbeat", 2],
  [/\b(photograph\w+|photo spots?)\b/i, "photography", 1],
  [/\b(live music|concerts?|gigs?|jazz)\b/i, "live-music", 2],
  [/\b(neighbourhoods?|neighborhoods?|wander\w*|stroll\w*)\b/i, "neighbourhoods", 1],
  [/\b(eat\w*|food|restaurants?|dining|dinner)\b/i, "food", 1],
];

const NEGATORS = /\b(no|not|none|avoid|skip|hate|dislike|without|rather not|don'?t (?:want|like))\b/i;

const RULES: Rule[] = [
  {
    // "my mother can't manage stairs", "no stairs please", "step-free"
    pattern: /\b(stairs?|steps?|step[- ]free|wheelchair|walking frame|mobility (?:issues?|problems?))\b/i,
    apply: (diff) => addConstraint(diff, { kind: "no-stairs" }),
  },
  {
    // "we can't walk far", "not much walking"
    pattern: /\b(can'?t walk (?:far|much)|not much walking|limited walking|short walks? only)\b/i,
    apply: (diff) => addConstraint(diff, { kind: "max-walking-metres", value: 2500 }),
  },
  {
    // "one really nice dinner", "a special meal out"
    pattern: /\b(one|a)\s+(?:really\s+|very\s+)?(nice|special|memorable|proper|good|fancy)\s+(dinner|meal|lunch)\b/i,
    apply: (diff, match) =>
      diff.specialRequests.push({
        descriptor: match[0].trim(),
        slot: /lunch/i.test(match[0]) ? "lunch" : "dinner",
        dayIndex: null,
      }),
  },
  {
    pattern: /\b(vegetarian|vegan|coeliac|celiac|gluten[- ]free|no shellfish|halal|kosher|allerg\w+)\b/i,
    apply: (diff, match) => diff.notes.push(`Dietary: ${match[0]}`),
  },
  {
    pattern: /\b(early riser|up early|early start)\b/i,
    apply: (diff) => diff.notes.push("Prefers early starts"),
  },
];

export function interpretFreeTextDeterministically(text: string): PreferenceDiff {
  const diff: PreferenceDiff = {
    interestDeltas: {},
    hardConstraints: [],
    specialRequests: [],
    notes: [],
  };

  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (match) rule.apply(diff, match);
  }

  for (const [pattern, tag, weight] of INTEREST_PHRASES) {
    const match = text.match(pattern);
    if (!match) continue;
    // Read the twelve characters before the phrase for a negation, so
    // "no nightlife" does not read as enthusiasm for nightlife.
    const start = Math.max(0, (match.index ?? 0) - 24);
    const preceding = text.slice(start, match.index ?? 0);
    const negated = NEGATORS.test(preceding);
    diff.interestDeltas[tag] = clamp(negated ? -weight : weight);
  }

  diff.notes.push(
    "Read without the language model: only clear phrases were picked up from your note.",
  );
  return diff;
}

function addConstraint(diff: PreferenceDiff, constraint: HardConstraint) {
  if (!diff.hardConstraints.some((c) => c.kind === constraint.kind)) {
    diff.hardConstraints.push(constraint);
  }
}

function clamp(value: number): number {
  return Math.max(-MAX_INTEREST_DELTA, Math.min(MAX_INTEREST_DELTA, value));
}
