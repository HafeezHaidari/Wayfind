import type { InterestLevel, PreferenceDiff, Preferences } from "../shared/types.js";
import { DAILY_WALK_CAP_M } from "../shared/planning-config.js";

/**
 * §6b job 1: "Output is a diff against the `Preferences` object, applied
 * deterministically." The LLM proposes; this function decides. Nothing here
 * calls a model, so the same diff always produces the same preferences and the
 * whole path is unit-testable.
 */

export type AppliedDiff = {
  preferences: Preferences;
  /** Extra walking cap in metres, when the note asked for one (§7d). */
  walkCapOverrideM: number | null;
  /** Traveller-facing notes to surface with the itinerary. */
  notes: string[];
};

export function applyPreferenceDiff(
  preferences: Preferences,
  diff: PreferenceDiff,
): AppliedDiff {
  const interests = { ...preferences.interests };
  const notes: string[] = [...diff.notes];
  let mobility = preferences.mobility;
  let walkCapOverrideM: number | null = null;

  for (const [tag, delta] of Object.entries(diff.interestDeltas)) {
    const key = tag as keyof typeof interests;
    const current = interests[key] ?? 1;
    interests[key] = clampLevel(current + (delta ?? 0));
  }

  for (const constraint of diff.hardConstraints) {
    switch (constraint.kind) {
      case "no-stairs":
      case "step-free":
        // The scorer already rewards wheelchair-tagged places under a reduced
        // mobility setting, so the honest mapping is to tighten mobility rather
        // than to invent a step-free flag the data cannot support.
        mobility = "minimal-walking";
        notes.push("Planning around step-free access where OpenStreetMap records it.");
        break;
      case "max-walking-metres":
        walkCapOverrideM = Math.min(
          constraint.value,
          walkCapOverrideM ?? Number.POSITIVE_INFINITY,
        );
        break;
      case "avoid-tag":
        interests[constraint.tag] = 0;
        notes.push(`Leaving out ${constraint.tag.replace("-", " ")} entirely.`);
        break;
    }
  }

  if (mobility === "minimal-walking" && walkCapOverrideM === null) {
    walkCapOverrideM = DAILY_WALK_CAP_M["minimal-walking"];
  }

  return {
    preferences: { ...preferences, interests, mobility },
    walkCapOverrideM,
    notes,
  };
}

function clampLevel(value: number): InterestLevel {
  return Math.max(0, Math.min(3, Math.round(value))) as InterestLevel;
}
