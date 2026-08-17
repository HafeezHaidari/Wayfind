import type { LatLng } from "../../shared/geo.js";
import type { Candidate } from "./candidates.js";
import { env } from "../env.js";

/**
 * §5a — the quality-signal provider seam.
 *
 * The default stack is OSM + Wikivoyage + Wikidata, all free and keyless.
 * Google Places would give the best quality signal (ratings, popularity) but is
 * the costly option, and the cost is worse than it looks: Google retired the
 * flat $200 monthly credit in March 2025 in favour of per-SKU free thresholds,
 * and requesting a `rating` field pushes the whole call into a higher-priced
 * tier (Place Details Enterprise rather than Essentials). For a trip that
 * ranks a few hundred candidates per city, that is real money per generation.
 *
 * So Google Places is not used in the default configuration (§0b: free tiers
 * only). This interface is the place it would plug in, behind a key, without
 * touching the sourcing procedure or the scorer.
 */

export type QualitySignalProvider = {
  name: string;
  /** True when the provider is configured and permitted to run. */
  available(): boolean;
  /**
   * Enrich candidates in place with whatever quality signal the provider has.
   * Must never add a candidate: providers rate what was found, they do not
   * introduce places (the same rule §6b applies to the LLM).
   */
  enrich(candidates: Candidate[], centre: LatLng): Promise<void>;
};

/** The default: no external quality provider beyond the free stack. */
export const noopProvider: QualitySignalProvider = {
  name: "none",
  available: () => false,
  async enrich() {
    /* the free stack already did the work */
  },
};

/**
 * Not implemented on purpose. Wiring this up means accepting per-request spend,
 * which §0b rules out; the shape is here so that decision stays a one-file
 * change rather than a refactor.
 */
export const googlePlacesProvider: QualitySignalProvider = {
  name: "google-places",
  available: () => env.googlePlacesKey !== null,
  async enrich() {
    throw new Error(
      "Google Places is deliberately not implemented: it would incur per-request spend, " +
        "which this build rules out (§0b). See the README for what it would cost.",
    );
  },
};

export function activeProvider(): QualitySignalProvider {
  return noopProvider;
}
