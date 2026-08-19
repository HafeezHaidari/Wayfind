import { CATEGORIES } from "./src/shared/categories.js";
import { bboxAround } from "./src/shared/geo.js";

const TOKYO = { lat: 35.6768601, lng: 139.7638947 };
const FOOD = new Set(["restaurant", "cafe", "bar"]);
const MIRROR = "https://overpass.private.coffee/api/interpreter";

function build(sightR: number, foodR: number) {
  const box = (r: number) => {
    const b = bboxAround(TOKYO, r);
    return [b.south, b.west, b.north, b.east].map((v) => v.toFixed(4)).join(",");
  };
  const usable = CATEGORIES.filter((c) => c.overpass.length > 0);
  const lines = [`[out:json][timeout:120][bbox:${box(sightR)}];`];
  const outs: string[] = [];
  usable.forEach((c, i) => {
    const b = FOOD.has(c.key) ? `(${box(foodR)})` : "";
    lines.push(`(${c.overpass.map((s) => `nwr${s}[name]${b};`).join(" ")})->.s${i};`);
    outs.push(`.s${i} out center tags ${c.fetchLimit};`);
  });
  return [...lines, ...outs].join("\n");
}

for (const [sightR, foodR] of [[6000, 3500], [3500, 2200]]) {
  const t0 = Date.now();
  try {
    const res = await fetch(MIRROR, {
      method: "POST",
      body: new URLSearchParams({ data: build(sightR, foodR) }),
      headers: { "User-Agent": "Wayfind/0.1 (single-user itinerary planner)" },
      signal: AbortSignal.timeout(180_000),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const text = await res.text();
    if (!res.ok) console.log(`Tokyo @${sightR}m: ${secs}s HTTP ${res.status}`);
    else {
      const d = JSON.parse(text);
      console.log(`Tokyo @${sightR}m: ${secs}s, ${d.elements?.length} elements, ${(text.length/1024).toFixed(0)} KB`);
    }
  } catch (e) {
    console.log(`Tokyo @${sightR}m: after ${((Date.now()-t0)/1000).toFixed(0)}s threw ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 8000));
}
