import type { Poi, Preferences } from "../../shared/types.js";
import { INTEREST_LABELS } from "../../shared/interests.js";

/**
 * The reason a stop is in the plan, stated from what the scorer actually used.
 *
 * §6c gives rationale writing to the LLM, and that call is off by default (§10)
 * and unavailable without a key. The itinerary still has to render correctly in
 * that case — but a stop with no reason at all reads as arbitrary, which is
 * exactly what §9c says the rationale exists to prevent. So this is the
 * deterministic floor: it names which of the traveller's own interests the
 * place matched and whether a human guide singled it out. Nothing is invented;
 * every clause comes from data already on the POI.
 */
export function plainWhy(poi: Poi, preferences: Preferences): string {
  const matched = poi.tags
    .filter((tag) => (preferences.interests[tag] ?? 1) >= 2)
    .slice(0, 2)
    .map((tag) => INTEREST_LABELS[tag].toLowerCase());

  const endorsed = poi.sourceIds.wikivoyage !== undefined || poi.provenance === "wikivoyage";

  if (matched.length > 0 && endorsed) {
    return `Matches your interest in ${listOf(matched)}, and the city guide singles it out.`;
  }
  if (matched.length > 0) {
    return `Matches your interest in ${listOf(matched)}.`;
  }
  if (endorsed) {
    return "The city guide singles this one out.";
  }
  return "Near your other stops, and it fits the day.";
}

function listOf(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
