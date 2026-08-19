import { USER_AGENT } from "../env.js";
import { debug, info } from "../log.js";

/**
 * §10 — Overpass and OSRM are free shared services. Everything that talks to
 * them goes through here: a sane timeout, a small number of retries, and real
 * backoff on 429 rather than an immediate retry that makes the problem worse.
 */

export type FetchOptions = {
  timeoutMs?: number;
  retries?: number;
  body?: string | URLSearchParams;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  label: string;
};

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_RETRIES = 2;
/**
 * 429 means "you are asking too fast", and on Overpass a 504 means the same
 * thing ("the server is probably too busy"). Retrying quickly makes it worse,
 * because the retry itself claims one of the two slots the public instance
 * allows per IP. Start at 10 seconds and double.
 */
const BACKOFF_BASE_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly service: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/**
 * §9g — "Errors do not apologise and are never vague."
 *
 * The raw failures upstream throws are not written for a traveller: undici says
 * "fetch failed" for anything from a DNS miss to a dropped connection, and
 * `UpstreamError` says "Overpass is rate-limiting or overloaded (504)". Both
 * reached the itinerary screen verbatim during a three-city trip. This turns
 * them into something that says what happened and what to do about it.
 */
export function travellerFacingError(err: unknown): string {
  if (err instanceof UpstreamError) {
    if (err.status === 429 || err.status === 503 || err.status === 504) {
      return (
        `${friendlyService(err.service)} is busy right now and asked Wayfind to slow down. ` +
        `It's a free service run by volunteers, so there's a queue. Wait a minute and try again — ` +
        `fewer cities at once will also help.`
      );
    }
    return `${friendlyService(err.service)} didn't answer properly. Try again in a moment.`;
  }

  const message = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/i.test(message)) {
    return "Couldn't reach the map and guide services. Check your connection, then try again.";
  }
  if (/timed out|timeout|aborted/i.test(message)) {
    return (
      "The map service took too long to answer. That usually means it's under load — " +
      "wait a minute and try again."
    );
  }
  return message;
}

function friendlyService(service: string): string {
  switch (service) {
    case "Overpass":
      return "OpenStreetMap's map-data service";
    case "OSRM":
      return "The routing service";
    case "Wikivoyage":
      return "Wikivoyage";
    case "Wikidata":
      return "Wikidata";
    default:
      return service;
  }
}

export async function fetchText(url: string, options: FetchOptions): Promise<string> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    body,
    method = body ? "POST" : "GET",
    headers = {},
    label,
  } = options;

  let lastError: Error | null = null;
  let retryAfterMs: number | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(retryAfterMs ?? BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      info(
        `${label}: busy, waiting ${Math.round(wait / 1000)}s before attempt ` +
          `${attempt + 1} of ${retries + 1}`,
      );
      await sleep(wait);
    }
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: {
          "User-Agent": USER_AGENT,
          ...(body instanceof URLSearchParams
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 429 || res.status === 504 || res.status === 503) {
        // The service usually tells us how long to wait; believe it over our guess.
        const header = res.headers.get("retry-after");
        const seconds = header ? Number(header) : NaN;
        retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
        lastError = new UpstreamError(
          `${label} is rate-limiting or overloaded (${res.status})`,
          res.status,
          label,
        );
        continue;
      }
      if (!res.ok) {
        throw new UpstreamError(`${label} returned ${res.status}`, res.status, label);
      }
      const text = await res.text();
      debug(`${label}: ${text.length} bytes`);
      return text;
    } catch (err) {
      if (err instanceof UpstreamError && err.status !== null && err.status < 500) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new UpstreamError(`${label} failed`, null, label);
}

export async function fetchJson<T>(url: string, options: FetchOptions): Promise<T> {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(`${options.label} returned something that isn't JSON`, null, options.label);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
