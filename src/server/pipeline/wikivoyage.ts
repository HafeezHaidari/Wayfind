import { fetchJson } from "./http.js";
import { info } from "../log.js";
import type { Counters } from "./counters.js";
import { wikiLimiter } from "./limiter.js";
import { env } from "../env.js";
import { readFixtureText } from "./fixtures.js";
import { fixtureSlug } from "./fixtures.js";

/**
 * §5a — Wikivoyage is the editorial judgment OSM lacks: a human decided these
 * places were worth listing, and roughly in what order. That is the quality
 * signal the whole ranking leans on.
 *
 * Its listings are structured templates rather than prose:
 *   {{see | name=Palácio da Bolsa | lat=41.14 | long=-8.61 | wikidata=Q1371109
 *        | hours=Daily 09:00-18:30 | price=€12 | content=... }}
 * so this is a template parser, not a text scraper.
 */

export type ListingKind = "see" | "do" | "eat" | "drink" | "buy" | "sleep" | "other";

export type WikivoyageListing = {
  name: string;
  alt: string | null;
  kind: ListingKind;
  /** The `==Section==` it sits under, e.g. "See" or "Eat". */
  section: string;
  /** The `===Subsection===`, often a neighbourhood, e.g. "Ribeira". */
  subsection: string | null;
  lat: number | null;
  lng: number | null;
  wikidata: string | null;
  hours: string | null;
  price: string | null;
  content: string;
  /** Position in the article. Earlier listings are more prominent (§6a). */
  order: number;
  /** How many listings that article had, so prominence stays per-article (§6a). */
  articleTotal: number;
};

const LISTING_TEMPLATES = new Set([
  "see",
  "do",
  "eat",
  "drink",
  "buy",
  "sleep",
  "listing",
  "vcard",
]);

/**
 * Fetch a city's article, trying each title in turn.
 *
 * English Wikivoyage titles its articles in English, while the geocoder answers
 * with the local name: 京都市 returns `missingtitle`, Kyoto returns a 62 KB
 * guide. So callers pass the English exonym first and the local name as a
 * fallback, and a miss on one is not a failure.
 */
export async function fetchWikivoyageArticle(
  titles: string | string[],
  counters: Counters,
): Promise<string | null> {
  const candidates = (Array.isArray(titles) ? titles : [titles])
    .map((t) => t?.trim())
    .filter((t): t is string => Boolean(t));
  const tried = new Set<string>();

  if (env.fixtureMode) {
    counters.wikivoyageFetches += 1;
    for (const title of candidates) {
      try {
        return readFixtureText(fixtureSlug(title), "wikivoyage.wikitext");
      } catch {
        continue;
      }
    }
    return null;
  }

  for (const title of candidates) {
    if (tried.has(title.toLowerCase())) continue;
    tried.add(title.toLowerCase());

    const url =
      "https://en.wikivoyage.org/w/api.php?" +
      new URLSearchParams({
        action: "parse",
        page: title,
        prop: "wikitext",
        format: "json",
        formatversion: "2",
        redirects: "1",
      }).toString();

    counters.wikivoyageFetches += 1;
    const body = await wikiLimiter.run(() =>
      fetchJson<{ parse?: { wikitext?: string }; error?: { code?: string } }>(url, {
        label: "Wikivoyage",
        timeoutMs: 30_000,
      }),
    );
    const wikitext = body.parse?.wikitext;
    if (wikitext) return wikitext;
    info(`Wikivoyage has no article titled "${title}"${body.error?.code ? ` (${body.error.code})` : ""}`);
  }
  return null;
}

/**
 * Parse an article's listings. Returns them in document order, which is the
 * order a knowledgeable editor put them in.
 */
export function parseListings(wikitext: string): WikivoyageListing[] {
  const out: WikivoyageListing[] = [];
  let section = "";
  let subsection: string | null = null;
  let order = 0;

  for (let i = 0; i < wikitext.length; i++) {
    // Track which section we are in as we scan.
    if (wikitext.startsWith("==", i) && (i === 0 || wikitext[i - 1] === "\n")) {
      const lineEnd = wikitext.indexOf("\n", i);
      const line = wikitext.slice(i, lineEnd === -1 ? undefined : lineEnd);
      const heading = line.match(/^(=+)\s*(.*?)\s*=+\s*$/);
      if (heading) {
        if (heading[1].length === 2) {
          section = heading[2];
          subsection = null;
        } else {
          subsection = heading[2];
        }
      }
      i = lineEnd === -1 ? wikitext.length : lineEnd;
      continue;
    }

    if (!wikitext.startsWith("{{", i)) continue;
    const block = readTemplate(wikitext, i);
    if (!block) continue;

    const parsed = parseTemplate(block.text);
    if (parsed && LISTING_TEMPLATES.has(parsed.name)) {
      const listing = toListing(parsed, section, subsection, order);
      if (listing) {
        out.push(listing);
        order += 1;
      }
    }
    i = block.end - 1;
  }

  for (const listing of out) listing.articleTotal = out.length;
  return out;
}

/**
 * §5a's editorial signal goes missing for exactly the biggest cities.
 *
 * English Wikivoyage splits a large city across district sub-articles — Tokyo's
 * own page carries 97 listings and every one of them is an embassy under
 * "Cope", while its 39 `Tokyo/…` district pages hold the museums and temples.
 * Parsing only the parent leaves Tokyo and Osaka ranked on OpenStreetMap alone.
 *
 * So when a parent article is thin, follow its district links. They appear in
 * article order, which is editorial order, so the first few are the central
 * districts a visitor actually wants.
 */
export async function fetchDistrictArticles(
  parentTitle: string,
  parentWikitext: string,
  counters: Counters,
  limit: number,
): Promise<string[]> {
  if (env.fixtureMode) return [];

  const prefix = `${parentTitle.toLowerCase()}/`;
  const links = [...parentWikitext.matchAll(/\[\[([^\]|#]+\/[^\]|#]+)(?:\|[^\]]*)?\]\]/g)]
    .map((m) => m[1].trim())
    .filter((link) => link.toLowerCase().startsWith(prefix));
  const districts = [...new Set(links)].slice(0, limit);
  if (districts.length === 0) return [];

  info(`Wikivoyage: ${parentTitle} is a district article; reading ${districts.length} of its districts`);
  // Issued together and throttled by the shared Wikimedia gate rather than
  // one-at-a-time: eight sequential round trips per city dominated the run.
  const fetched = await Promise.all(
    districts.map((district) => fetchWikivoyageArticle(district, counters).catch(() => null)),
  );
  return fetched.filter((wikitext): wikitext is string => wikitext !== null);
}

// --- template reading --------------------------------------------------------

/** Read a `{{...}}` block from `start`, respecting nesting. */
function readTemplate(text: string, start: number): { text: string; end: number } | null {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text.startsWith("{{", i)) {
      depth++;
      i++;
    } else if (text.startsWith("}}", i)) {
      depth--;
      i++;
      if (depth === 0) return { text: text.slice(start + 2, i - 1), end: i + 1 };
    }
    // A template that never closes is malformed; give up rather than scanning
    // the rest of a 78 KB article for it.
    if (i - start > 8000) return null;
  }
  return null;
}

type ParsedTemplate = { name: string; params: Record<string, string> };

function parseTemplate(inner: string): ParsedTemplate | null {
  const parts = splitTopLevel(inner, "|");
  if (parts.length === 0) return null;
  const name = parts[0].trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return { name, params };
}

/** Split on a delimiter that is not inside `{{ }}` or `[[ ]]`. */
function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("{{", i) || text.startsWith("[[", i)) {
      depth++;
      current += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (text.startsWith("}}", i) || text.startsWith("]]", i)) {
      depth--;
      current += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (depth === 0 && text[i] === delimiter) {
      parts.push(current);
      current = "";
      continue;
    }
    current += text[i];
  }
  parts.push(current);
  return parts;
}

function toListing(
  template: ParsedTemplate,
  section: string,
  subsection: string | null,
  order: number,
): WikivoyageListing | null {
  const p = template.params;
  const name = cleanWikitext(p.name ?? "");
  if (!name) return null;

  // `{{listing}}` and `{{vcard}}` carry their kind in a `type` parameter.
  const kindSource = template.name === "listing" || template.name === "vcard" ? (p.type ?? "") : template.name;
  const kind = normaliseKind(kindSource, section);

  return {
    name,
    alt: p.alt ? cleanWikitext(p.alt) || null : null,
    kind,
    section,
    subsection,
    lat: numberOrNull(p.lat),
    lng: numberOrNull(p.long ?? p.lon ?? p.lng),
    wikidata: p.wikidata?.trim().match(/^Q\d+$/) ? p.wikidata.trim() : null,
    hours: p.hours ? cleanWikitext(p.hours) || null : null,
    price: p.price ? cleanWikitext(p.price) || null : null,
    content: cleanWikitext(p.content ?? ""),
    order,
    articleTotal: 0, // set by parseListings once the article is fully read
  };
}

function normaliseKind(raw: string, section: string): ListingKind {
  const value = raw.trim().toLowerCase();
  if (value === "see" || value === "do" || value === "eat" || value === "drink") return value;
  if (value === "buy" || value === "sleep") return value;
  const bySection = section.trim().toLowerCase();
  if (bySection === "see" || bySection === "do" || bySection === "eat" || bySection === "drink") {
    return bySection;
  }
  if (bySection === "buy" || bySection === "sleep") return bySection;
  return "other";
}

function numberOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Strip the wiki markup that would otherwise leak into a place name. */
export function cleanWikitext(value: string): string {
  return value
    .replace(/\{\{[^{}]*\}\}/g, "") // nested templates: {{Dead link}} and friends
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // [[target|label]]
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1") // [url label]
    .replace(/\[https?:\/\/\S+\]/g, "")
    .replace(/'''?/g, "")
    .replace(/<ref[^>]*>.*?<\/ref>/gs, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * §5a names the sections worth parsing: "See", "Do", "Eat", "Drink". Being
 * more permissive than that pulled Tokyo's embassies into the itinerary as
 * monuments, because they are listed under "Cope" and an unrecognised section
 * fell through to a generic default. A section allowlist is both closer to the
 * brief and the fix.
 */
const VISITOR_SECTIONS = new Set(["see", "do", "eat", "drink", "buy"]);

export function isVisitable(listing: WikivoyageListing): boolean {
  if (listing.name.length <= 1) return false;
  if (listing.kind === "sleep" || listing.kind === "other") return false;
  return VISITOR_SECTIONS.has(listing.section.trim().toLowerCase());
}
