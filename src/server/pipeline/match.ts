import { haversineM, type LatLng } from "../../shared/geo.js";

/**
 * §5b steps 3 and 5 — match Wikivoyage entries to OSM objects, then
 * deduplicate. The same museum appears as "Museu Nacional Soares dos Reis" in
 * OSM, "Soares dos Reis National Museum" in Wikivoyage, and once more as a
 * separate node for its garden. Getting this wrong shows up as the same place
 * twice in one day, which reads as broken.
 *
 * A shared Wikidata id is proof. Everything else is name similarity plus
 * proximity, and both must agree.
 */

/** Below this, two names are not the same place however close they are. */
const NAME_THRESHOLD = 0.62;
/** A Wikivoyage listing and an OSM object further apart than this are not one place. */
const MATCH_RADIUS_M = 350;
/** Two candidates closer than this with near-identical names are duplicates. */
const DEDUPE_RADIUS_M = 200;
const DEDUPE_NAME_THRESHOLD = 0.8;

/** Words that carry no distinguishing information across languages we meet. */
const STOPWORDS = new Set([
  "the","a","an","of","and",
  "o","a","os","as","do","da","dos","das","de","e",
  "el","la","los","las","del","y",
  "le","les","du","des","et",
  "il","lo","gli","di",
  "der","die","das","und","von",
  "museu","museum","museo","musee","musée",
  "igreja","church","iglesia","eglise","église",
  "palacio","palácio","palace","palais",
  "jardim","jardins","garden","gardens","jardin",
  "casa","house","centro","center","centre",
  "national","nacional","municipal","city",
]);

export function normaliseName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // Keep every script's letters and digits, not just Latin: stripping to
      // [a-z0-9] reduced 迎賓館 to an empty string, so every Japanese name
      // scored zero against every other and matching silently stopped working.
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function significantTokens(name: string): string[] {
  return normaliseName(name)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * 0 to 1. Blends token overlap (robust to word order and to translated generic
 * words) with edit distance over the whole string (robust to a single differing
 * token). Either alone produces obvious false matches.
 */
export function nameSimilarity(a: string, b: string): number {
  const normA = normaliseName(a);
  const normB = normaliseName(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const tokensA = significantTokens(a);
  const tokensB = significantTokens(b);
  const overlap = jaccard(new Set(tokensA), new Set(tokensB));

  // One name entirely containing the other's significant tokens is a strong
  // signal: "Sé" vs "Sé do Porto", "Serralves" vs "Museu de Serralves".
  const containment =
    tokensA.length > 0 && tokensB.length > 0
      ? countShared(tokensA, tokensB) / Math.min(tokensA.length, tokensB.length)
      : 0;

  const edit = 1 - levenshtein(normA, normB) / Math.max(normA.length, normB.length);

  return Math.max(overlap * 0.5 + edit * 0.5, containment * 0.75 + edit * 0.25);
}

export type Matchable = {
  name: string;
  lat: number;
  lng: number;
  wikidata?: string | null;
};

/**
 * Best match for `needle` among `haystack`, or null. Coordinates are optional
 * on the needle: many Wikivoyage listings carry them, some do not, and a
 * listing without coordinates can still be matched on name alone if the name is
 * distinctive enough.
 */
export function bestMatch<T extends Matchable>(
  needle: { name: string; lat: number | null; lng: number | null; wikidata?: string | null },
  haystack: T[],
): { item: T; confidence: number } | null {
  if (needle.wikidata) {
    const exact = haystack.find((h) => h.wikidata && h.wikidata === needle.wikidata);
    if (exact) return { item: exact, confidence: 1 };
  }

  let best: { item: T; confidence: number } | null = null;
  const hasCoords = needle.lat !== null && needle.lng !== null;

  for (const candidate of haystack) {
    const similarity = nameSimilarity(needle.name, candidate.name);
    if (similarity < NAME_THRESHOLD) continue;

    let confidence = similarity;
    if (hasCoords) {
      const metres = haversineM(
        { lat: needle.lat as number, lng: needle.lng as number },
        candidate,
      );
      if (metres > MATCH_RADIUS_M) continue;
      // Close and similarly named beats similarly named alone.
      confidence = similarity * (1 - Math.min(0.35, metres / MATCH_RADIUS_M / 3));
    } else if (similarity < 0.8) {
      // Without coordinates, only a strong name match is trustworthy.
      continue;
    }

    if (!best || confidence > best.confidence) best = { item: candidate, confidence };
  }
  return best;
}

/**
 * Collapse duplicates within one candidate set. `preferred` decides which of
 * two duplicates survives: the one that keeps the most useful data.
 */
export function dedupeBy<T extends Matchable>(items: T[], preferred: (a: T, b: T) => T): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const existingIndex = kept.findIndex((k) => isSamePlace(k, item));
    if (existingIndex === -1) {
      kept.push(item);
      continue;
    }
    kept[existingIndex] = preferred(kept[existingIndex], item);
  }
  return kept;
}

export function isSamePlace(a: Matchable, b: Matchable): boolean {
  if (a.wikidata && b.wikidata) return a.wikidata === b.wikidata;
  const metres = haversineM(a, b);
  if (metres > DEDUPE_RADIUS_M) return false;
  return nameSimilarity(a.name, b.name) >= DEDUPE_NAME_THRESHOLD;
}

// --- string metrics ----------------------------------------------------------

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return shared / (a.size + b.size - shared);
}

function countShared(a: string[], b: string[]): number {
  const setB = new Set(b);
  return a.filter((t) => setB.has(t)).length;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

export type { LatLng };
