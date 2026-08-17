import { fetchJson } from "./http.js";
import type { Counters } from "./counters.js";
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

export async function fetchWikivoyageArticle(
  cityName: string,
  counters: Counters,
): Promise<string | null> {
  if (env.fixtureMode) {
    counters.wikivoyageFetches += 1;
    try {
      return readFixtureText(fixtureSlug(cityName), "wikivoyage.wikitext");
    } catch {
      return null;
    }
  }

  const url =
    "https://en.wikivoyage.org/w/api.php?" +
    new URLSearchParams({
      action: "parse",
      page: cityName,
      prop: "wikitext",
      format: "json",
      formatversion: "2",
      redirects: "1",
    }).toString();

  counters.wikivoyageFetches += 1;
  const body = await fetchJson<{ parse?: { wikitext?: string }; error?: unknown }>(url, {
    label: "Wikivoyage",
    timeoutMs: 30_000,
  });
  return body.parse?.wikitext ?? null;
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

  return out;
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

/** Listings worth treating as candidates: places you go, not places you sleep. */
export function isVisitable(listing: WikivoyageListing): boolean {
  return listing.kind !== "sleep" && listing.name.length > 1;
}
