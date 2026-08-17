import "dotenv/config";

/**
 * Every environment-derived setting, read once. §0c requires the build to run
 * with no keys at all, so nothing here throws on a missing value.
 */
export const env = {
  port: Number(process.env.PORT ?? 8787),

  /** §11a — end to end with no network and no keys. */
  fixtureMode: process.env.FIXTURE_MODE === "true",
  /** §10 — verbose payload logging, development only. */
  debugPipeline: process.env.DEBUG_PIPELINE === "true",
  /** §10 — cosmetic LLM spend, off by default. */
  enableRationale: process.env.ENABLE_RATIONALE === "true",

  anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
  llmModel: process.env.LLM_MODEL?.trim() || "claude-haiku-4-5-20251001",

  overpassUrl: process.env.OVERPASS_URL?.trim() || "https://overpass-api.de/api/interpreter",
  osrmUrl: (process.env.OSRM_URL?.trim() || "https://router.project-osrm.org").replace(/\/$/, ""),
  nominatimUrl: (
    process.env.NOMINATIM_URL?.trim() || "https://nominatim.openstreetmap.org"
  ).replace(/\/$/, ""),

  googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY?.trim() || null,
};

/** Free services ask for a real identifying User-Agent. Give them one. */
export const USER_AGENT = "Wayfind/0.1 (personal itinerary planner; single user)";

export function llmAvailable(): boolean {
  return env.anthropicKey !== null && !env.fixtureMode;
}
