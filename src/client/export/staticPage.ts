import type { Itinerary, Poi, Preferences, TripBrief } from "../../shared/types.js";
import { formatClock, formatDayLabel, formatDuration } from "../../shared/dates.js";
import { CATEGORY_BY_KEY } from "../../shared/categories.js";
import { buildTimeline, slackMinutes, travelMinutes } from "../model/timeline.js";
import { plainWhy } from "../model/why.js";
import { renderRouteSvg } from "./mapSvg.js";

/**
 * §9f — the offline-capable static export.
 *
 * "The exported static page must render fully without network access — no CDN
 * fonts, no live map tiles, everything inlined." So this page carries:
 *   - every stylesheet rule the app is currently using, read back from the CSSOM
 *   - the three type families as base64 `@font-face` rules
 *   - the day's route as inline SVG rather than tiles
 * and nothing else. Opened from a phone in flight mode, it is complete.
 */

export async function buildStaticPage(brief: TripBrief, itinerary: Itinerary): Promise<string> {
  const [appCss, fontCss] = await Promise.all([collectStyles(), fetchInlineFonts()]);
  const title = brief.name.trim() || `${itinerary.cities.map((c) => c.cityName).join(" and ")}`;

  const body = itinerary.cities
    .map((city) =>
      city.days
        .map((day) => {
          const blocks = buildTimeline(day, city.meals[day.dayIndex] ?? [], itinerary.pois, {
            approximateTravel: brief.preferences.transport !== "walk",
          });
          const stops = blocks
            .filter((b) => b.kind === "stop")
            .map((b) => (b.kind === "stop" ? b.poi : null))
            .filter((p): p is Poi => p !== null);

          return `
<section class="print-day export-day">
  <header class="print-day__head">
    <h2 class="print-day__city">${escapeHtml(city.cityName)}</h2>
    <p class="print-day__date">${escapeHtml(
      formatDayLabel(day.date) ?? `Day ${day.dayIndex + 1}`,
    )}</p>
  </header>

  <p class="day-summary">
    <span>${day.stops.length} ${day.stops.length === 1 ? "stop" : "stops"}</span>
    <span>${formatDuration(travelMinutes(blocks))} moving</span>
    <span>${formatDuration(slackMinutes(blocks))} free</span>
  </p>

  <ol class="rail">
    ${blocks.map((block) => renderBlock(block, brief.preferences)).join("\n")}
  </ol>

  ${stops.length > 1 ? `<figure class="export-map-figure">${renderRouteSvg(stops)}<figcaption>The day's route, in order. Distances are as the crow flies.</figcaption></figure>` : ""}

  ${
    day.warnings.length > 0
      ? `<section class="day-warnings">
    <p class="day-warnings__title">Worth checking before you go</p>
    <ul>${day.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
  </section>`
      : ""
  }
</section>`;
        })
        .join("\n"),
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Wayfind</title>
<style>
${fontCss}
${appCss}
${EXPORT_CSS}
</style>
</head>
<body class="export">
<header class="export-head">
  <p class="eyebrow">Wayfind</p>
  <h1 class="export-title">${escapeHtml(title)}</h1>
  <p class="export-sub">
    ${itinerary.cities
      .map((c) => `${escapeHtml(c.cityName)} · ${c.days.length} ${c.days.length === 1 ? "day" : "days"}`)
      .join(" &middot; ")}
  </p>
  <p class="export-note">
    Saved from Wayfind. This page works with no signal — everything it needs is inside it.
    Places marked "hours unconfirmed" are worth a check before you set out.
  </p>
</header>

${body}

<footer class="export-foot">
  <p>
    Places from OpenStreetMap and Wikivoyage contributors, under ODbL and CC BY-SA.
    Travel times are estimates.
  </p>
</footer>
</body>
</html>`;
}

function renderBlock(
  block: ReturnType<typeof buildTimeline>[number],
  preferences: Preferences,
): string {
  const minutes = block.endMin - block.startMin;
  const style = `style="--block-minutes:${minutes}"`;

  if (block.kind === "stop") {
    const { poi, stop } = block;
    const category = poi.category ? CATEGORY_BY_KEY[poi.category].label : "Place";
    return `<li class="rail-block rail-block--stop"${stop.pinned ? ' data-pinned="true"' : ""}${
      block.warning ? ' data-caution="true"' : ""
    } ${style}>
  <div class="rail-block__spine">
    <time class="rail-block__time mono">${formatClock(stop.arriveMin)}</time>
    <span class="rail-block__duration mono">${formatDuration(minutes)}</span>
  </div>
  <div class="rail-block__body">
    <div class="rail-block__head">
      <h3 class="rail-block__name place-name">${escapeHtml(poi.name)}</h3>
      ${poi.localName ? `<span class="rail-block__local">${escapeHtml(poi.localName)}</span>` : ""}
      ${stop.pinned ? '<span class="tag tag--locked">Pinned</span>' : ""}
    </div>
    <p class="rail-block__why${stop.rationale ? "" : " rail-block__why--plain"}">${escapeHtml(
      stop.rationale ?? plainWhy(poi, preferences),
    )}</p>
    <p class="rail-block__meta">
      <span class="rail-block__category">${escapeHtml(category)}</span>
      <span aria-hidden="true"> · </span>
      <span class="mono">${formatClock(stop.arriveMin)}–${formatClock(stop.departMin)}</span>
      ${
        block.warning
          ? '<span aria-hidden="true"> · </span><span class="rail-block__caution">Hours unconfirmed</span>'
          : ""
      }
    </p>
    <p class="export-coords mono">${poi.lat.toFixed(5)}, ${poi.lng.toFixed(5)}</p>
  </div>
</li>`;
  }

  if (block.kind === "meal") {
    const label = block.meal.kind === "lunch" ? "Lunch" : "Dinner";
    return `<li class="rail-block rail-block--meal" ${style}>
  <div class="rail-block__spine">
    <time class="rail-block__time mono">${formatClock(block.startMin)}</time>
    <span class="rail-block__duration mono">${formatDuration(minutes)}</span>
  </div>
  <div class="rail-block__body">
    <h3 class="rail-block__name place-name">${escapeHtml(block.poi ? block.poi.name : label)}</h3>
    <p class="rail-block__meta">${label}${block.poi ? " · worth booking" : " · time held"}</p>
  </div>
</li>`;
  }

  if (block.kind === "travel") {
    const mode = preferences.transport === "walk" ? "walk" : `by ${preferences.transport}`;
    return `<li class="rail-block rail-block--travel" ${style}>
  <div class="rail-block__spine"></div>
  <p class="rail-block__travel mono">${block.approximate ? "≈" : ""}${block.minutes} min ${mode}</p>
</li>`;
  }

  return `<li class="rail-block rail-block--slack"${block.minutes > 42 ? ' data-capped="true"' : ""} ${style}>
  <div class="rail-block__spine"></div>
  <p class="rail-block__slack mono">${formatDuration(block.minutes)} free</p>
</li>`;
}

/**
 * Read every rule the app is currently styled by straight out of the CSSOM.
 * That keeps the export honest: it looks like what the user just approved,
 * without a second copy of the stylesheet drifting out of date.
 */
async function collectStyles(): Promise<string> {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet; nothing of ours lives there
    }
    for (const rule of Array.from(rules)) {
      // Font faces and imports are replaced by the inlined base64 versions.
      if (rule instanceof CSSImportRule) continue;
      if (rule instanceof CSSFontFaceRule) continue;
      if (rule.cssText.includes(".leaflet")) continue; // no map widget in the export
      parts.push(rule.cssText);
    }
  }
  return parts.join("\n");
}

/** The three §9b families, base64-encoded, generated by scripts/fetch-fonts.ts. */
async function fetchInlineFonts(): Promise<string> {
  try {
    const response = await fetch("/fonts/inline.css");
    if (!response.ok) throw new Error(String(response.status));
    return await response.text();
  } catch {
    // Without them the page still renders, in the fallback stacks the tokens name.
    return "/* Fonts could not be inlined; falling back to system faces. */";
  }
}

/** Layout the export needs and the app does not: it is a document, not an app. */
const EXPORT_CSS = `
body.export {
  max-width: 46rem;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
}
.export-head { margin-bottom: 2.5rem; }
.export-title {
  font-family: var(--font-place);
  font-variation-settings: "wdth" 112;
  font-weight: 700;
  font-size: 2.25rem;
  margin: 0.25rem 0 0.5rem;
}
.export-sub { font-family: var(--font-spine); font-size: 0.8125rem; color: var(--ink-soft); }
.export-note {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--hairline);
  color: var(--ink-soft);
  font-size: 0.9375rem;
  max-width: 42ch;
}
.export-day { margin-bottom: 3.5rem; }
.export-coords { font-size: 0.75rem; color: var(--rail); margin-top: 0.25rem; }
.export-map-figure { margin: 1.5rem 0 0; }
.export-map {
  width: 100%;
  height: auto;
  border: 1px solid var(--hairline-strong);
  border-radius: 2px;
  background: var(--paper-sunk);
}
.export-map__route { fill: none; stroke: var(--ink); stroke-width: 1.5; stroke-dasharray: 4 4; }
.export-map__pin { fill: var(--ink); }
.export-map__label {
  fill: var(--paper);
  font-family: var(--font-spine);
  font-size: 11px;
  text-anchor: middle;
}
.export-map__scale line { stroke: var(--ink-soft); stroke-width: 1; }
.export-map__scale text {
  fill: var(--ink-soft);
  font-family: var(--font-spine);
  font-size: 10px;
  text-anchor: middle;
}
.export-map-figure figcaption {
  font-size: 0.8125rem;
  color: var(--ink-soft);
  margin-top: 0.5rem;
}
.export-foot {
  margin-top: 3rem;
  padding-top: 1rem;
  border-top: 1px solid var(--hairline);
  font-size: 0.8125rem;
  color: var(--ink-soft);
}
@media print {
  body.export { max-width: none; padding: 0; }
  .export-head { break-after: page; page-break-after: always; }
  .export-map-figure { break-inside: avoid; }
}
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
