import type { InterestTag, InterestLevel, Preferences } from "./types.js";
import { INTEREST_TAGS } from "./interests.js";

/**
 * Every field has a sensible default so a user can skip the interview entirely
 * and still get an itinerary (§4). Nothing in the pipeline may block on an
 * unanswered question.
 *
 * The default interest profile is deliberately mild rather than empty: a
 * neutral 1 across the board, lifted to 2 on the things nearly every traveller
 * ends up doing. An all-zero profile would mean "avoid everything" and produce
 * nothing at all.
 */
const DEFAULT_INTEREST_LEVEL: InterestLevel = 1;
const DEFAULT_ELEVATED: InterestTag[] = ["neighbourhoods", "food", "viewpoints", "history"];

export function defaultInterests(): Record<InterestTag, InterestLevel> {
  const out = {} as Record<InterestTag, InterestLevel>;
  for (const tag of INTEREST_TAGS) out[tag] = DEFAULT_INTEREST_LEVEL;
  for (const tag of DEFAULT_ELEVATED) out[tag] = 2;
  return out;
}

export function defaultPreferences(): Preferences {
  return {
    pace: "moderate",
    dayStart: "midmorning",
    dayEnd: "moderate",
    interests: defaultInterests(),
    budget: "moderate",
    mobility: "moderate",
    transport: "walk",
    foodImportance: 2,
    avoidCrowds: false,
    travellingWith: "solo",
  };
}
