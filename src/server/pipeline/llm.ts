import Anthropic from "@anthropic-ai/sdk";
import type {
  HardConstraint,
  InterestTag,
  Poi,
  PreferenceDiff,
  Preferences,
  ScheduledStop,
} from "../../shared/types.js";
import { INTEREST_TAGS } from "../../shared/interests.js";
import { MAX_INTEREST_DELTA } from "../../shared/scoring-config.js";
import { formatClock } from "../../shared/dates.js";
import { env, llmAvailable } from "../env.js";
import { debug, info } from "../log.js";
import type { Counters } from "./counters.js";
import { interpretFreeTextDeterministically } from "./free-text-fallback.js";

/**
 * §6b — the LLM layer, and its hard limit.
 *
 * The LLM does exactly three jobs: interpret the free-text box, pick from an
 * already-retrieved shortlist when category tags are too coarse, and write the
 * per-stop rationale. It ranks, filters and explains; it does not generate.
 *
 * **The LLM never produces a place name.** Every call that touches POIs
 * receives candidates as input and must return `Poi.id` values. Returned ids
 * are validated against the input set and anything unrecognised is discarded
 * and logged as a bug, never visited. That structural rule is what keeps this
 * from being the kind of AI planner that confidently recommends a restaurant
 * which closed in 2019.
 *
 * Every function here degrades: with no key, job 1 falls back to a
 * deterministic keyword reading and jobs 2 and 3 return nothing, which the
 * itinerary renders correctly (§6c).
 */

/** Small model: none of these three tasks needs a frontier model (§10). */
function client(): Anthropic {
  return new Anthropic({ apiKey: env.anthropicKey ?? undefined });
}

/** Deliberately short outputs — these are structured, not prose essays. */
const MAX_TOKENS_STRUCTURED = 1024;
const MAX_TOKENS_RATIONALE = 2048;

// --- Job 1: interpret the free-text box (§6b.1) -------------------------------

const PREFERENCE_DIFF_SCHEMA = {
  type: "object",
  properties: {
    interestDeltas: {
      type: "array",
      description: "Category weight adjustments implied by the traveller's note.",
      items: {
        type: "object",
        properties: {
          tag: { type: "string", enum: INTEREST_TAGS },
          delta: {
            type: "integer",
            description: "Between -2 and 2. Negative means they want less of it.",
          },
        },
        required: ["tag", "delta"],
        additionalProperties: false,
      },
    },
    hardConstraints: {
      type: "array",
      description: "Non-negotiables, e.g. someone who cannot manage stairs.",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["no-stairs", "step-free", "max-walking-metres", "avoid-tag"],
          },
          value: {
            type: "integer",
            description: "Metres, for max-walking-metres. Zero otherwise.",
          },
          tag: {
            type: "string",
            enum: [...INTEREST_TAGS, "none"],
            description: "The category to avoid, for avoid-tag. 'none' otherwise.",
          },
        },
        required: ["kind", "value", "tag"],
        additionalProperties: false,
      },
    },
    specialRequests: {
      type: "array",
      description:
        "Requests for a particular kind of place in a particular slot, e.g. one really nice dinner.",
      items: {
        type: "object",
        properties: {
          descriptor: {
            type: "string",
            description: "The traveller's own words for what they want.",
          },
          slot: { type: "string", enum: ["dinner", "lunch", "any"] },
          dayIndex: {
            type: "integer",
            description: "Zero-based day it applies to, or -1 for any day.",
          },
        },
        required: ["descriptor", "slot", "dayIndex"],
        additionalProperties: false,
      },
    },
    notes: {
      type: "array",
      description: "Anything relevant that did not fit the fields above.",
      items: { type: "string" },
    },
  },
  required: ["interestDeltas", "hardConstraints", "specialRequests", "notes"],
  additionalProperties: false,
} as const;

const FREE_TEXT_SYSTEM = `You turn a traveller's free-text note into structured adjustments to their trip preferences.

You are reading one paragraph written at the end of a short questionnaire. It contains the things the structured questions missed: dietary needs, someone's mobility, a request for one special meal, a place they have already booked.

Rules:
- Only report what the note actually says. Do not infer a taste for museums from a mention of a rainy day.
- Interest deltas are small nudges, -2 to 2. A note saying "we love markets" is +2 for markets, not a rewrite of the whole trip.
- A hard constraint is a non-negotiable about what the traveller can physically do or must avoid, not a preference.
- Never invent place names. You are not choosing anywhere; you are only reading the note.
- An empty result is correct when the note says nothing actionable.`;

export async function interpretFreeText(
  freeText: string | null,
  preferences: Preferences,
  counters: Counters,
): Promise<PreferenceDiff> {
  const text = freeText?.trim();
  if (!text) return emptyDiff();

  if (!llmAvailable()) {
    // §6b degrades rather than disappearing: a keyword reading catches the
    // common cases and is honest about being cruder than the model.
    return interpretFreeTextDeterministically(text);
  }

  try {
    counters.llmCalls += 1;
    debug("free-text interpretation: prompt", text);
    const response = await client().messages.create({
      model: env.llmModel,
      max_tokens: MAX_TOKENS_STRUCTURED,
      system: FREE_TEXT_SYSTEM,
      output_config: { format: { type: "json_schema", schema: PREFERENCE_DIFF_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `Traveller's note:\n"""\n${text}\n"""\n\nTheir current pace is ${preferences.pace} and they are travelling ${preferences.travellingWith}.`,
        },
      ],
    });

    const raw = firstJson(response);
    debug("free-text interpretation: response", raw);
    return raw ? normaliseDiff(raw) : interpretFreeTextDeterministically(text);
  } catch (err) {
    info(`free-text interpretation failed, using keyword fallback: ${String(err)}`);
    return interpretFreeTextDeterministically(text);
  }
}

// --- Job 2: semantic matching over retrieved candidates (§6b.2) ---------------

const SELECTION_SCHEMA = {
  type: "object",
  properties: {
    ids: {
      type: "array",
      description: "Ids copied exactly from the candidate list, best first.",
      items: { type: "string" },
    },
  },
  required: ["ids"],
  additionalProperties: false,
} as const;

const SEMANTIC_SYSTEM = `You pick which of a fixed list of places best fits a traveller's description.

The list is everything that is available. You may only return ids that appear in it, copied exactly. You may return fewer than asked, or none, if nothing fits.

You are choosing, not suggesting. Never write a place name that is not in the list, and never invent an id.`;

/**
 * Given a shortlist of already-retrieved candidates, pick which best fit a
 * free-text descriptor ("somewhere atmospheric for a last dinner").
 *
 * Returns only ids that were in the input. Anything else is dropped and logged.
 */
export async function semanticMatch(
  descriptor: string,
  candidates: Poi[],
  limit: number,
  counters: Counters,
): Promise<string[]> {
  if (!llmAvailable() || candidates.length === 0) return [];

  const allowed = new Set(candidates.map((c) => c.id));
  const listing = candidates
    .slice(0, 40)
    .map((c) => `${c.id} | ${c.name} | ${c.tags.join(", ")} | price tier ${c.priceTier ?? "unknown"}`)
    .join("\n");

  try {
    counters.llmCalls += 1;
    const response = await client().messages.create({
      model: env.llmModel,
      max_tokens: MAX_TOKENS_STRUCTURED,
      system: SEMANTIC_SYSTEM,
      output_config: { format: { type: "json_schema", schema: SELECTION_SCHEMA } },
      messages: [
        {
          role: "user",
          content:
            `The traveller wants: "${descriptor}"\n\n` +
            `Pick up to ${limit}, best first.\n\nCandidates (id | name | tags | price):\n${listing}`,
        },
      ],
    });

    const raw = firstJson(response) as { ids?: unknown } | null;
    const ids = Array.isArray(raw?.ids) ? raw.ids : [];
    return validateIds(ids, allowed, "semantic match").slice(0, limit);
  } catch (err) {
    info(`semantic match failed, falling back to score order: ${String(err)}`);
    return [];
  }
}

// --- Job 3: per-stop rationale (§6c) ------------------------------------------

const RATIONALE_SCHEMA = {
  type: "object",
  properties: {
    rationales: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The stop id, copied exactly." },
          line: {
            type: "string",
            description: "One sentence: why this place, and why at this time.",
          },
        },
        required: ["id", "line"],
        additionalProperties: false,
      },
    },
  },
  required: ["rationales"],
  additionalProperties: false,
} as const;

const RATIONALE_SYSTEM = `You write one short line per stop on a day of someone's trip, explaining why that place was chosen and why it sits at that time of day.

Write from the traveller's side of the screen: "Worth the climb first thing, before the queues" — not "high notability score, scheduled early to satisfy constraints".

Rules:
- One sentence each. Concrete, specific to the place, and never generic praise.
- Only use facts given to you. Do not add history, prices, or claims about what is inside.
- Only return ids from the list you were given, copied exactly. Never rename a place.
- Say why the time matters when it does — opening hours, light, meals, crowds — and otherwise say why the place earns its slot.`;

export type RationaleInput = {
  id: string;
  name: string;
  category: string;
  arriveMin: number;
  durationMin: number;
  matchedInterests: string[];
  editorialListed: boolean;
  hoursNote: string | null;
};

/**
 * §6c — batched: one call per day, not one per stop. Cosmetic, so a failure
 * returns an empty map and every rationale renders as null.
 */
export async function writeRationales(
  cityName: string,
  dayLabel: string,
  stops: RationaleInput[],
  counters: Counters,
): Promise<Record<string, string>> {
  if (!llmAvailable() || !env.enableRationale || stops.length === 0) return {};

  const allowed = new Set(stops.map((s) => s.id));
  const listing = stops
    .map(
      (s) =>
        `${s.id} | ${s.name} | ${s.category} | arrives ${formatClock(s.arriveMin)} for ${s.durationMin} min` +
        ` | matches: ${s.matchedInterests.join(", ") || "none stated"}` +
        `${s.editorialListed ? " | listed in the city's Wikivoyage guide" : ""}` +
        `${s.hoursNote ? ` | ${s.hoursNote}` : ""}`,
    )
    .join("\n");

  try {
    counters.llmCalls += 1;
    const response = await client().messages.create({
      model: env.llmModel,
      max_tokens: MAX_TOKENS_RATIONALE,
      system: RATIONALE_SYSTEM,
      output_config: { format: { type: "json_schema", schema: RATIONALE_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `${dayLabel} in ${cityName}. The day, in order:\n\n${listing}`,
        },
      ],
    });

    const raw = firstJson(response) as { rationales?: unknown } | null;
    const entries = Array.isArray(raw?.rationales) ? raw.rationales : [];
    const out: Record<string, string> = {};
    for (const entry of entries) {
      const item = entry as { id?: unknown; line?: unknown };
      if (typeof item.id !== "string" || typeof item.line !== "string") continue;
      if (!allowed.has(item.id)) {
        // §6b: an id that was not in the input is a bug to log, not a place.
        info(`rationale returned an unknown stop id and was discarded: ${item.id}`);
        continue;
      }
      out[item.id] = item.line.trim();
    }
    return out;
  } catch (err) {
    info(`rationale generation failed, stops will render without one: ${String(err)}`);
    return {};
  }
}

/** Attach rationales to a day's stops, leaving them null when none was written. */
export function applyRationales(
  stops: ScheduledStop[],
  rationales: Record<string, string>,
): ScheduledStop[] {
  return stops.map((stop) => ({ ...stop, rationale: rationales[stop.poiId] ?? stop.rationale }));
}

// --- shared helpers -----------------------------------------------------------

/**
 * §6b's structural guarantee, in one place: ids the model returned that were
 * not in the input set are discarded and logged.
 */
export function validateIds(ids: unknown[], allowed: Set<string>, context: string): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    if (!allowed.has(id)) {
      info(`${context} returned an id that was not in the candidate set: ${id}`);
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function firstJson(response: Anthropic.Message): unknown {
  for (const block of response.content) {
    if (block.type === "text") {
      try {
        return JSON.parse(block.text);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function emptyDiff(): PreferenceDiff {
  return { interestDeltas: {}, hardConstraints: [], specialRequests: [], notes: [] };
}

/** Clamp whatever came back into the shape and range the scorer will accept. */
function normaliseDiff(raw: unknown): PreferenceDiff {
  const source = raw as {
    interestDeltas?: { tag?: unknown; delta?: unknown }[];
    hardConstraints?: { kind?: unknown; value?: unknown; tag?: unknown }[];
    specialRequests?: { descriptor?: unknown; slot?: unknown; dayIndex?: unknown }[];
    notes?: unknown[];
  };
  const validTags = new Set<string>(INTEREST_TAGS);
  const diff = emptyDiff();

  for (const item of source.interestDeltas ?? []) {
    if (typeof item.tag !== "string" || !validTags.has(item.tag)) continue;
    const delta = Number(item.delta);
    if (!Number.isFinite(delta) || delta === 0) continue;
    diff.interestDeltas[item.tag as InterestTag] = clamp(
      Math.round(delta),
      -MAX_INTEREST_DELTA,
      MAX_INTEREST_DELTA,
    );
  }

  for (const item of source.hardConstraints ?? []) {
    const constraint = toHardConstraint(item, validTags);
    if (constraint) diff.hardConstraints.push(constraint);
  }

  for (const item of source.specialRequests ?? []) {
    if (typeof item.descriptor !== "string" || item.descriptor.trim() === "") continue;
    const slot = item.slot === "dinner" || item.slot === "lunch" ? item.slot : "any";
    const dayIndex = Number(item.dayIndex);
    diff.specialRequests.push({
      descriptor: item.descriptor.trim(),
      slot,
      dayIndex: Number.isInteger(dayIndex) && dayIndex >= 0 ? dayIndex : null,
    });
  }

  for (const note of source.notes ?? []) {
    if (typeof note === "string" && note.trim()) diff.notes.push(note.trim());
  }

  return diff;
}

function toHardConstraint(
  item: { kind?: unknown; value?: unknown; tag?: unknown },
  validTags: Set<string>,
): HardConstraint | null {
  switch (item.kind) {
    case "no-stairs":
      return { kind: "no-stairs" };
    case "step-free":
      return { kind: "step-free" };
    case "max-walking-metres": {
      const value = Number(item.value);
      return Number.isFinite(value) && value > 0
        ? { kind: "max-walking-metres", value: Math.round(value) }
        : null;
    }
    case "avoid-tag":
      return typeof item.tag === "string" && validTags.has(item.tag)
        ? { kind: "avoid-tag", tag: item.tag as InterestTag }
        : null;
    default:
      return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
