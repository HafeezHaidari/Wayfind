/**
 * Drives the running app in a headless browser: builds an itinerary, then
 * screenshots and measures it.
 *
 * The measurement half is not decoration. §11b asks for proof that "stop block
 * heights on the time rail are proportional to duration", and the only place
 * that is actually true is the rendered box, not the model — so this reads back
 * `getBoundingClientRect` per block and prints the height-per-minute for each.
 *
 *   npx tsx scripts/preview.ts [--url http://localhost:5173] [--out shots]
 */
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const url = argValue("--url") ?? "http://localhost:5173";
const outDir = argValue("--out") ?? "screens";

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`  [console error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => console.log(`  [page error] ${err.message}`));

  console.log("→ trip setup");
  await page.goto(url, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${outDir}/1-setup.png`, fullPage: true });

  await page.fill("#trip-name", "Three days in Porto");
  await page.locator("button", { hasText: "Add city" }).first().click();
  await page.fill("#city-0", "Porto");
  await page.locator("button", { hasText: /^Find$/ }).first().click();
  await page.waitForSelector("text=Located", { timeout: 20_000 });

  // Give the stay real dates, so weekday closures are exercised.
  await page.locator('.choice:has(.choice__label:text-is("Dates"))').click();
  await page.fill("#start-0", "2026-09-08");
  await page.fill("#end-0", "2026-09-10");

  await page.locator("button", { hasText: "Next: your preferences" }).click();
  console.log("→ interview");
  await page.waitForSelector("text=How full do you want your days?");
  await page.screenshot({ path: `${outDir}/2-interview-pace.png`, fullPage: true });

  await page.locator("button", { hasText: "Next: Rhythm" }).click();
  await page.locator("button", { hasText: "Next: Interests" }).click();
  await page.waitForSelector("text=What are you here for?");
  await page.click('.interest:has-text("Museums")');
  await page.click('.interest:has-text("Viewpoints")');
  await page.screenshot({ path: `${outDir}/3-interview-interests.png`, fullPage: true });

  await page.locator("button", { hasText: "Skip the rest" }).click();

  console.log("→ itinerary");
  await page.waitForSelector(".rail-block--stop", { timeout: 60_000 });
  await page.waitForTimeout(1200); // let the map settle
  await page.screenshot({ path: `${outDir}/4-itinerary.png`, fullPage: true });
  await page.screenshot({ path: `${outDir}/4-itinerary-fold.png` });

  await measureRail(page);

  // Hover sync (§9c): a hovered stop should light its pin.
  await page.hover(".rail-block--stop");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/5-hover-sync.png` });
  const activePins = await page.locator(".map-pin--active").count();
  console.log(`\nrail→map sync: ${activePins} pin(s) highlighted on hover`);

  // Mobile (§9c): the rail goes full width and the map must not eat it.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(url, { waitUntil: "networkidle" });
  await buildQuickTrip(mobile);
  await mobile.waitForSelector(".rail-block--stop", { timeout: 60_000 });
  await mobile.waitForTimeout(800);
  await mobile.screenshot({ path: `${outDir}/6-mobile.png`, fullPage: true });
  const overflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`mobile horizontal overflow: ${overflow}px (0 is correct)`);

  await browser.close();
  console.log(`\nScreenshots in ${outDir}/`);
}

/** §11b — read the rendered heights back and prove they track duration. */
async function measureRail(page: Page) {
  const measured = await page.evaluate(() => {
    const out: { name: string; minutes: number; height: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".rail-block--stop")) {
      const minutes = Number(el.style.getPropertyValue("--block-minutes"));
      const name = el.querySelector(".rail-block__name")?.textContent?.trim() ?? "?";
      out.push({ name, minutes, height: Math.round(el.getBoundingClientRect().height) });
    }
    return out;
  });

  console.log("\nrail block heights (§9a proportionality):");
  for (const row of measured) {
    const perMinute = (row.height / row.minutes).toFixed(2);
    console.log(
      `  ${String(row.minutes).padStart(4)} min  ${String(row.height).padStart(4)} px  ` +
        `${perMinute} px/min  ${row.name}`,
    );
  }
  const sorted = [...measured].sort((a, b) => a.minutes - b.minutes);
  if (sorted.length >= 2) {
    const shortest = sorted[0];
    const longest = sorted[sorted.length - 1];
    console.log(
      `  → ${longest.minutes} min renders ${(longest.height / shortest.height).toFixed(2)}× ` +
        `the height of ${shortest.minutes} min`,
    );
  }
}

async function buildQuickTrip(page: Page) {
  await page.locator("button", { hasText: "Add city" }).first().click();
  await page.fill("#city-0", "Porto");
  await page.locator("button", { hasText: /^Find$/ }).first().click();
  await page.waitForSelector("text=Located", { timeout: 20_000 });
  await page.locator("button", { hasText: "Next: your preferences" }).click();
  await page.locator("button", { hasText: "Skip the rest" }).click();
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
