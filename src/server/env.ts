import "dotenv/config";

/**
 * Every environment-derived setting, in one place. §0c requires the build to
 * run with no keys at all, so nothing here throws on a missing value.
 *
 * Read lazily through getters rather than captured at import time, so a test
 * can flip FIXTURE_MODE without juggling dynamic imports.
 */
export const env = {
  get port(): number {
    return Number(process.env.PORT ?? 8787);
  },

  /** §11a — end to end with no network and no keys. */
  get fixtureMode(): boolean {
    return process.env.FIXTURE_MODE === "true";
  },
  /** §10 — verbose payload logging, development only. */
  get debugPipeline(): boolean {
    return process.env.DEBUG_PIPELINE === "true";
  },
  /** §10 — cosmetic LLM spend, off by default. */
  get enableRationale(): boolean {
    return process.env.ENABLE_RATIONALE === "true";
  },

  get anthropicKey(): string | null {
    return process.env.ANTHROPIC_API_KEY?.trim() || null;
  },
  get llmModel(): string {
    return process.env.LLM_MODEL?.trim() || "claude-haiku-4-5";
  },

  get overpassUrl(): string {
    return process.env.OVERPASS_URL?.trim() || "https://overpass-api.de/api/interpreter";
  },
  get osrmUrl(): string {
    return (process.env.OSRM_URL?.trim() || "https://router.project-osrm.org").replace(/\/$/, "");
  },
  get nominatimUrl(): string {
    return (process.env.NOMINATIM_URL?.trim() || "https://nominatim.openstreetmap.org").replace(
      /\/$/,
      "",
    );
  },

  get googlePlacesKey(): string | null {
    return process.env.GOOGLE_PLACES_API_KEY?.trim() || null;
  },
};

/** Free services ask for a real identifying User-Agent. Give them one. */
export const USER_AGENT = "Wayfind/0.1 (personal itinerary planner; single user)";

export function llmAvailable(): boolean {
  return env.anthropicKey !== null && !env.fixtureMode;
}
