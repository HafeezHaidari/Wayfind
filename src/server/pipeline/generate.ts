import type { Itinerary } from "../../shared/types.js";

/**
 * The generation pipeline. Assembled in §0d stages 3-5; until then the endpoint
 * fails loudly rather than returning an empty success (§11c).
 */
export async function generateItinerary(_body: unknown): Promise<Itinerary> {
  throw new Error("The itinerary pipeline is not built yet (§0d stages 3-5).");
}
