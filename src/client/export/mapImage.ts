import type { Poi } from "../../shared/types.js";

/**
 * §9f — "map replaced by a static image or omitted".
 *
 * The first version of the export drew the route as bare SVG: numbered dots and
 * dashed lines on an empty field. It rendered correctly and told you almost
 * nothing — no streets, no river, no orientation — so it did not read as a map
 * at all. This composes a real one instead: OpenStreetMap tiles for the day's
 * area, fetched at export time while there is still a network, stitched onto a
 * canvas, with the route drawn over them, and flattened into a single data URI.
 *
 * The result needs no network to display, which is the whole point of §9f.
 *
 * Politeness (the tile server is free and volunteer-run): the zoom is chosen so
 * a day fits in a handful of tiles, the total is capped, requests go out a few
 * at a time, and attribution is rendered into the caption. This is one export
 * for one person's trip, which is comparable to panning the map in a browser.
 */

const TILE_SIZE = 256;
/** Never fetch more than this per day, whatever the area. */
const MAX_TILES = 12;
const MAX_ZOOM = 17;
const MIN_ZOOM = 10;
/** Output size; kept modest so nine days of maps stay a sane file. */
const OUT_WIDTH = 720;
const OUT_HEIGHT = 420;
const JPEG_QUALITY = 0.82;

export type MapImage = { dataUri: string; attribution: string };

export async function renderMapImage(stops: Poi[]): Promise<MapImage | null> {
  if (stops.length === 0 || typeof document === "undefined") return null;

  const lats = stops.map((s) => s.lat);
  const lngs = stops.map((s) => s.lng);
  // Pad the bounds so pins are never flush against the edge.
  const pad = 0.0035;
  const bounds = {
    north: Math.max(...lats) + pad,
    south: Math.min(...lats) - pad,
    east: Math.max(...lngs) + pad,
    west: Math.min(...lngs) - pad,
  };

  const plan = planTiles(bounds);
  if (!plan) return null;

  const canvas = document.createElement("canvas");
  canvas.width = plan.pixelWidth;
  canvas.height = plan.pixelHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#e8ebea";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const drawn = await drawTiles(ctx, plan);
  // If not a single tile arrived, the caller falls back to the line drawing
  // rather than shipping an empty grey rectangle.
  if (drawn === 0) return null;

  drawRoute(ctx, stops, plan);

  const out = document.createElement("canvas");
  const scale = Math.min(OUT_WIDTH / canvas.width, OUT_HEIGHT / canvas.height, 1);
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  const outCtx = out.getContext("2d");
  if (!outCtx) return null;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(canvas, 0, 0, out.width, out.height);

  return {
    dataUri: out.toDataURL("image/jpeg", JPEG_QUALITY),
    attribution: "© OpenStreetMap contributors",
  };
}

// --- tile mathematics --------------------------------------------------------

type TilePlan = {
  zoom: number;
  minTileX: number;
  minTileY: number;
  tilesX: number;
  tilesY: number;
  /** Pixel offset of the crop within the tile grid. */
  offsetX: number;
  offsetY: number;
  pixelWidth: number;
  pixelHeight: number;
};

function lngToTileX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * 2 ** zoom;
}

function latToTileY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom;
}

/** The highest zoom at which the day still fits inside the tile budget. */
function planTiles(bounds: { north: number; south: number; east: number; west: number }): TilePlan | null {
  for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom--) {
    const left = lngToTileX(bounds.west, zoom);
    const right = lngToTileX(bounds.east, zoom);
    const top = latToTileY(bounds.north, zoom);
    const bottom = latToTileY(bounds.south, zoom);

    const minTileX = Math.floor(left);
    const minTileY = Math.floor(top);
    const tilesX = Math.floor(right) - minTileX + 1;
    const tilesY = Math.floor(bottom) - minTileY + 1;
    if (tilesX * tilesY > MAX_TILES) continue;

    return {
      zoom,
      minTileX,
      minTileY,
      tilesX,
      tilesY,
      offsetX: (left - minTileX) * TILE_SIZE,
      offsetY: (top - minTileY) * TILE_SIZE,
      pixelWidth: Math.max(1, Math.round((right - left) * TILE_SIZE)),
      pixelHeight: Math.max(1, Math.round((bottom - top) * TILE_SIZE)),
    };
  }
  return null;
}

async function drawTiles(ctx: CanvasRenderingContext2D, plan: TilePlan): Promise<number> {
  const jobs: { x: number; y: number }[] = [];
  for (let x = 0; x < plan.tilesX; x++) {
    for (let y = 0; y < plan.tilesY; y++) jobs.push({ x, y });
  }

  let drawn = 0;
  // A few at a time: enough to be quick, gentle enough on a shared service.
  const CONCURRENCY = 3;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const images = await Promise.all(
      batch.map((job) => loadTile(plan.zoom, plan.minTileX + job.x, plan.minTileY + job.y)),
    );
    images.forEach((image, index) => {
      if (!image) return;
      const job = batch[index];
      ctx.drawImage(image, job.x * TILE_SIZE - plan.offsetX, job.y * TILE_SIZE - plan.offsetY);
      drawn += 1;
    });
  }
  return drawn;
}

async function loadTile(zoom: number, x: number, y: number): Promise<ImageBitmap | null> {
  const max = 2 ** zoom;
  if (y < 0 || y >= max) return null;
  const wrappedX = ((x % max) + max) % max;
  try {
    const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`, {
      // The tile server sends `access-control-allow-origin: *`, so the canvas
      // stays untainted and `toDataURL` works.
      mode: "cors",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

// --- the route on top --------------------------------------------------------

function drawRoute(ctx: CanvasRenderingContext2D, stops: Poi[], plan: TilePlan) {
  const points = stops.map((stop) => ({
    x: (lngToTileX(stop.lng, plan.zoom) - plan.minTileX) * TILE_SIZE - plan.offsetX,
    y: (latToTileY(stop.lat, plan.zoom) - plan.minTileY) * TILE_SIZE - plan.offsetY,
  }));

  // A pale casing under the line keeps it legible over dark map detail.
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(241, 243, 242, 0.9)";
  ctx.lineWidth = 7;
  ctx.setLineDash([]);
  stroke(ctx, points);

  ctx.strokeStyle = "#10201F";
  ctx.lineWidth = 3;
  ctx.setLineDash([9, 7]);
  stroke(ctx, points);
  ctx.setLineDash([]);

  points.forEach((point, index) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = "#10201F";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#F1F3F2";
    ctx.stroke();

    ctx.fillStyle = "#F1F3F2";
    ctx.font = "600 15px ui-monospace, 'SF Mono', Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(index + 1), point.x, point.y + 1);
  });
}

function stroke(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]) {
  if (points.length < 2) return;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
}
