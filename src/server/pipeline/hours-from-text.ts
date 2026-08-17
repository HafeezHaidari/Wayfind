import OpeningHoursLib from "opening_hours";
import type { OpeningHours } from "../../shared/types.js";

/**
 * Wikivoyage records hours as prose ("Daily 09:00-18:30", "Tu-Su 10:00-17:00,
 * closed holidays"). OSM records them in a formal grammar. Converting prose to
 * the grammar in general is guesswork, and guessing here means sending someone
 * to a closed door, so this converts only the handful of shapes that are
 * unambiguous and returns null for everything else.
 *
 * Null is not a failure: §7c treats unknown hours as schedulable-with-a-warning,
 * which is the honest outcome for prose we cannot read.
 */

const DAILY_PATTERNS: [RegExp, string][] = [
  [/^daily\b/i, "Mo-Su"],
  [/^every day\b/i, "Mo-Su"],
  [/^open daily\b/i, "Mo-Su"],
];

/** Characters that appear in the OSM grammar. Anything else means prose. */
const GRAMMAR_SHAPE = /^[A-Za-z0-9\s:,;\-+.\/]+$/;

export function hoursFromWikivoyage(text: string | null): OpeningHours | null {
  if (!text) return null;
  let candidate = text.trim();
  if (!candidate) return null;

  for (const [pattern, replacement] of DAILY_PATTERNS) {
    if (pattern.test(candidate)) {
      candidate = candidate.replace(pattern, replacement);
      break;
    }
  }

  // Drop a trailing prose clause: "Tu-Su 10:00-18:00, closed on holidays".
  candidate = candidate.replace(/,?\s*(closed|last admission|except)\b.*$/i, "").trim();
  if (!candidate || !GRAMMAR_SHAPE.test(candidate)) return null;
  // Without a clock time there is nothing to schedule against.
  if (!/\d{1,2}[:.]\d{2}/.test(candidate)) return null;

  candidate = candidate.replace(/(\d{1,2})\.(\d{2})/g, "$1:$2");

  try {
    const lib = new OpeningHoursLib(candidate, {
      lat: 0,
      lon: 0,
      address: { country_code: "", state: "" },
    } as never);
    const warnings = typeof lib.getWarnings === "function" ? lib.getWarnings() : [];
    if (warnings && warnings.length > 0) return null;
    // A rule that parses but is never open is a misread, not a schedule.
    if (!opensAtSomePoint(lib)) return null;
    return { raw: candidate, source: "wikivoyage" };
  } catch {
    return null;
  }
}

function opensAtSomePoint(lib: InstanceType<typeof OpeningHoursLib>): boolean {
  const base = new Date("2024-01-07T00:00:00");
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour += 2) {
      const at = new Date(base.getTime() + day * 86_400_000 + hour * 3_600_000);
      try {
        if (lib.getState(at)) return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}
