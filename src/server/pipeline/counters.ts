import type { PipelineCounters } from "../../shared/types.js";
import { info } from "../log.js";

/**
 * §10 — instrument each generation with how many third-party calls it made.
 * Aggregate counters only, never payloads, and nothing tied to a user.
 */
export class Counters implements PipelineCounters {
  overpassQueries = 0;
  osrmCalls = 0;
  wikivoyageFetches = 0;
  wikidataFetches = 0;
  llmCalls = 0;
  cacheHits = 0;
  cacheMisses = 0;

  snapshot(): PipelineCounters {
    return {
      overpassQueries: this.overpassQueries,
      osrmCalls: this.osrmCalls,
      wikivoyageFetches: this.wikivoyageFetches,
      wikidataFetches: this.wikidataFetches,
      llmCalls: this.llmCalls,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
    };
  }

  report(label: string) {
    info(`generation complete: ${label}`, this.snapshot());
  }
}
