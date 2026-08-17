import { env } from "./env.js";

/**
 * §10 — with DEBUG_PIPELINE off, only aggregate counters and error stages are
 * logged. Payloads (POI records, LLM prompts and responses) are gated behind
 * the flag and never reach the default log.
 */

export function info(message: string, fields?: Record<string, unknown>) {
  console.log(`[wayfind] ${message}${fields ? " " + JSON.stringify(fields) : ""}`);
}

export function errorAt(stage: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[wayfind] failed at ${stage}: ${message}`);
}

/** Payload-bearing logs. Silent unless DEBUG_PIPELINE=true. */
export function debug(message: string, payload?: unknown) {
  if (!env.debugPipeline) return;
  console.log(`[wayfind:debug] ${message}`, payload ?? "");
}
