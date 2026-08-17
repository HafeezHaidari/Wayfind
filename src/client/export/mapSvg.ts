import type { Poi } from "../../shared/types.js";

/**
 * §9f — the exported page must render with the network disabled, so it cannot
 * use map tiles. This draws the day's route as inline SVG from the coordinates
 * the itinerary already carries: the shape of the walk, the order of the stops,
 * and a scale bar so the distances mean something. No tiles, no requests, no
 * blank map region.
 */

export function renderRouteSvg(stops: Poi[], width = 640, height = 360): string {
  if (stops.length === 0) return "";

  const lat0 = stops.reduce((sum, p) => sum + p.lat, 0) / stops.length;
  const cos = Math.cos((lat0 * Math.PI) / 180);
  const points = stops.map((p) => ({ x: p.lng * cos, y: -p.lat, poi: p }));

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const pad = 34;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);

  // Centre the drawing in the box rather than stretching it: a distorted map is
  // worse than a small one.
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const placed = points.map((p) => ({
    ...p,
    px: offsetX + (p.x - minX) * scale,
    py: offsetY + (p.y - minY) * scale,
  }));

  const path = placed.map((p, i) => `${i === 0 ? "M" : "L"}${p.px.toFixed(1)} ${p.py.toFixed(1)}`).join(" ");

  // A scale bar, so the drawing is readable as distance and not just as shape.
  const metresPerUnit = 111_320;
  const barMetres = niceDistance((width - pad * 2) / scale / 3 * metresPerUnit);
  const barPx = (barMetres / metresPerUnit) * scale;

  const markers = placed
    .map(
      (p, i) => `
    <g>
      <circle cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="11" class="export-map__pin" />
      <text x="${p.px.toFixed(1)}" y="${(p.py + 4).toFixed(1)}" class="export-map__label">${i + 1}</text>
    </g>`,
    )
    .join("");

  return `<svg class="export-map" viewBox="0 0 ${width} ${height}" role="img"
     aria-label="Route between the day's stops, in order">
  <path d="${path}" class="export-map__route" />
  ${markers}
  <g class="export-map__scale" transform="translate(${pad}, ${height - 16})">
    <line x1="0" y1="0" x2="${barPx.toFixed(1)}" y2="0" />
    <line x1="0" y1="-4" x2="0" y2="4" />
    <line x1="${barPx.toFixed(1)}" y1="-4" x2="${barPx.toFixed(1)}" y2="4" />
    <text x="${(barPx / 2).toFixed(1)}" y="-8">${formatMetres(barMetres)}</text>
  </g>
</svg>`;
}

function niceDistance(metres: number): number {
  const steps = [100, 200, 250, 500, 1000, 2000, 5000, 10_000];
  return steps.find((s) => s >= metres) ?? steps[steps.length - 1];
}

function formatMetres(metres: number): string {
  return metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
}
