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
/** 429 means "you are asking too fast"; the first wait must be long enough to matter. */
const BACKOFF_BASE_MS = 4_000;

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

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      info(`${label}: retrying in ${wait}ms (attempt ${attempt + 1} of ${retries + 1})`);
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
