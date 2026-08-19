/**
 * The client's whole view of the server. The server is a stateless pipeline:
 * brief in, itinerary out (§1). Nothing here sends anything the server keeps.
 */
import type { Itinerary, Pin, TripBrief } from "../shared/types.js";

export type GeocodeResult = {
  displayName: string;
  cityName: string;
  lat: number;
  lng: number;
  /** ISO 3166-1 alpha-2; public-holiday opening rules need it (§7c). */
  countryCode: string | null;
  /** English exonym, when it differs — Wikivoyage articles are titled in English. */
  englishName: string | null;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly stage: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Can't reach the Wayfind server. Check that it's running, then try again.");
  }
  return handle<T>(res);
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to the status-based message */
  }
  if (!res.ok) {
    const err = payload as { error?: string; stage?: string } | null;
    throw new ApiError(err?.error ?? `The server returned ${res.status}.`, err?.stage ?? null);
  }
  return payload as T;
}

export async function geocode(query: string): Promise<GeocodeResult[]> {
  let res: Response;
  try {
    res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
  } catch {
    throw new ApiError("Can't reach the Wayfind server. Check that it's running, then try again.");
  }
  const body = await handle<{ results: GeocodeResult[] }>(res);
  return body.results;
}

export type GenerateRequest = {
  brief: TripBrief;
  pins: Pin[];
  /** Reuse the candidate set from a previous generation (§8) when true. */
  reuseCandidates: boolean;
  /** Places the traveller removed; the scheduler will not re-offer them. */
  removedPoiIds: string[];
};

export async function generate(req: GenerateRequest): Promise<Itinerary> {
  return post<Itinerary>("/api/generate", req);
}

export type ServerStatus = {
  ok: boolean;
  fixtureMode: boolean;
  rationaleEnabled: boolean;
  llmConfigured: boolean;
  fixtureCities: string[];
};

export async function status(): Promise<ServerStatus> {
  const res = await fetch("/api/status");
  return handle<ServerStatus>(res);
}
