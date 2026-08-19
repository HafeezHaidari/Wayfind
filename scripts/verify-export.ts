/**
 * §11b, the two acceptance criteria that can only be checked in a browser:
 *
 *   "The exported static page renders completely with the network disabled —
 *    no missing fonts, no blank map region, no broken layout."
 *   "Printing produces one readable day per page with no interactive chrome."
 *
 * So: drive the app, take the export, then open it in a context where every
 * outbound request is aborted, and measure what actually rendered. Then print
 * it to PDF and count the pages.
 *
 *   npx tsx scripts/verify-export.ts [--url http://localhost:5173]
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser, type BrowserType } from "playwright";

const url = argValue("--url") ?? "http://localhost:5173";
const outDir = argValue("--out") ?? "screens";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();

  console.log("Building a trip and taking the export…");
  const exportPath = await captureExport(browser);
  const bytes = (await stat(exportPath)).size;
  console.log(`  export written: ${exportPath} (${(bytes / 1024).toFixed(0)} KB)\n`);

  console.log("§11b — the exported page with the network disabled:");
  await verifyOffline(browser, exportPath);

  console.log("\n§11b — printing:");
  await verifyPrint(browser, exportPath);

  await browser.close();

  /*
   * And again in WebKit. An inline SVG with only a viewBox has no intrinsic
   * size, and WebKit resolved the stylesheet's `height: auto` to zero — the
   * route drawing was present, 688px wide, 0px tall, and invisible in Safari
   * and Quick Look. Chromium rendered it correctly, so a Chromium-only check
   * passed while the export was broken for anyone on a Mac.
   */
  console.log("\n§9f — the same page in WebKit (Safari's engine):");
  const safari = await webkit.launch();
  await verifyOffline(safari, exportPath, "webkit");
  await safari.close();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function captureExport(browser: Browser): Promise<string> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(url, { waitUntil: "networkidle" });

  await page.fill("#trip-name", "Three days in Porto");
  await page.locator("button", { hasText: "Add city" }).first().click();
  await page.fill("#city-0", "Porto");
  await page.locator("button", { hasText: /^Find$/ }).first().click();
  await page.waitForSelector("text=Located", { timeout: 20_000 });
  await page.locator('.choice:has(.choice__label:text-is("Dates"))').click();
  await page.fill("#start-0", "2026-09-08");
  await page.fill("#end-0", "2026-09-10");
  await page.locator("button", { hasText: "Next: your preferences" }).click();
  await page.locator("button", { hasText: "Skip the rest" }).click();
  await page.waitForSelector(".rail-block--stop", { timeout: 60_000 });

  await page.locator("button", { hasText: /^Export$/ }).click();
  await page.waitForSelector("text=A page you can read offline");

  const download = page.waitForEvent("download");
  await page.locator("button", { hasText: "Save the page" }).click();
  const file = await download;
  const path = join(outDir, "exported-trip.html");
  await file.saveAs(path);
  await page.close();
  return path;
}

async function verifyOffline(browser: Browser, exportPath: string, engine = "chromium") {
  // WebKit errors out on a file:// navigation with request interception active,
  // so the network-blocking half runs in Chromium only. That is no loss: this
  // second pass exists to check how the page *renders* in Safari's engine, and
  // the page has no network dependency left to re-prove.
  const intercept = engine === "chromium";
  const context = await browser.newContext({
    viewport: { width: 1100, height: 1400 },
    offline: intercept,
  });
  const page = await context.newPage();

  const attempted: string[] = [];
  if (intercept) {
    // Belt and braces: refuse every request that is not the file itself.
    await page.route("**/*", (route) => {
      const target = route.request().url();
      if (target.startsWith("file://")) return route.continue();
      attempted.push(target);
      return route.abort();
    });
  }

  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto(`file://${join(process.cwd(), exportPath)}`, { waitUntil: "load" });
  await page.waitForTimeout(1200);

  if (intercept) {
    check("no outbound requests attempted", attempted.length === 0, attempted.slice(0, 3).join(", "));
  }
  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  const measured = (await page.evaluate(`(() => {
    const railBlocks = document.querySelectorAll(".rail-block--stop");
    const heights = Array.from(railBlocks).map((el) => ({
      minutes: Number(el.style.getPropertyValue("--block-minutes")),
      height: Math.round(el.getBoundingClientRect().height),
    }));
    const nameEl = document.querySelector(".rail-block__name");
    const timeEl = document.querySelector(".rail-block__time");
    return {
      stops: railBlocks.length,
      heights,
      svgs: document.querySelectorAll(".export-map-figure img, .export-map-figure svg").length,
      mapKind: document.querySelector(".export-map-img") ? "tiles" : "schematic",
      svgWidth: document.querySelector(".export-map-figure img, .export-map-figure svg")
        ? document.querySelector(".export-map-figure img, .export-map-figure svg").getBoundingClientRect().width
        : 0,
      svgHeight: document.querySelector(".export-map-figure img, .export-map-figure svg")
        ? document.querySelector(".export-map-figure img, .export-map-figure svg").getBoundingClientRect().height
        : 0,
      mapSrcIsInline: (() => {
        const img = document.querySelector(".export-map-img");
        return img ? img.getAttribute("src").startsWith("data:") : true;
      })(),
      warnings: document.querySelectorAll(".day-warnings").length,
      cautionLabels: document.querySelectorAll(".rail-block__caution").length,
      placeFont: nameEl ? getComputedStyle(nameEl).fontFamily : "",
      spineFont: timeEl ? getComputedStyle(timeEl).fontFamily : "",
      fontsLoaded: Array.from(document.fonts)
        .filter((f) => f.status === "loaded")
        .map((f) => f.family),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      docHeight: document.documentElement.scrollHeight,
    };
  })()`)) as {
    stops: number;
    heights: { minutes: number; height: number }[];
    svgs: number;
    mapKind: string;
    svgWidth: number;
    svgHeight: number;
    mapSrcIsInline: boolean;
    warnings: number;
    cautionLabels: number;
    placeFont: string;
    spineFont: string;
    fontsLoaded: string[];
    bodyBg: string;
    overflowX: number;
    docHeight: number;
  };

  check("stops rendered", measured.stops > 0, `${measured.stops} stops`);
  check("day warnings preserved", measured.warnings > 0, `${measured.warnings} block(s)`);
  check(
    "hours-unconfirmed labels preserved",
    measured.cautionLabels > 0,
    `${measured.cautionLabels} label(s)`,
  );
  // Width alone is not enough: a zero-height SVG is still "present" and still
  // reports its full width. That is exactly how this shipped broken once.
  check(
    "day map present, not a blank region",
    measured.svgs > 0 && measured.svgWidth > 200 && measured.svgHeight > 100,
    `${measured.svgs} map(s), ${measured.mapKind}, ` +
      `${Math.round(measured.svgWidth)}×${Math.round(measured.svgHeight)}px`,
  );
  check("day map is embedded, not linked", measured.mapSrcIsInline);
  check("no horizontal overflow", measured.overflowX === 0, `${measured.overflowX}px`);
  check("page has real content height", measured.docHeight > 800, `${measured.docHeight}px`);

  const embeddedFamilies = new Set(measured.fontsLoaded);
  check(
    "embedded fonts loaded offline",
    embeddedFamilies.has("Archivo") && embeddedFamilies.has("IBM Plex Mono"),
    [...embeddedFamilies].join(", ") || "none",
  );
  check("place names use the display face", measured.placeFont.includes("Archivo"), measured.placeFont);
  check("times use the mono spine", measured.spineFont.includes("IBM Plex Mono"), measured.spineFont);

  // The rail must still be proportional in the export.
  const ratios = measured.heights.filter((h) => h.minutes > 0).map((h) => h.height / h.minutes);
  const consistent =
    ratios.length > 1 && Math.max(...ratios) - Math.min(...ratios) < 0.05;
  check(
    "rail still proportional in the export",
    consistent,
    ratios.map((r) => r.toFixed(2)).join(", "),
  );

  await page.screenshot({ path: `${outDir}/7-export-offline-${engine}.png`, fullPage: true });
  await context.close();
}

async function verifyPrint(browser: Browser, exportPath: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`file://${join(process.cwd(), exportPath)}`, { waitUntil: "load" });
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(500);

  // NB: no inner function declarations here — the TS runner injects a `__name`
  // helper into them that does not exist in the page.
  const chrome = await page.evaluate(`(() => {
    const displayOf = (sel) => {
      const el = document.querySelector(sel);
      return el === null ? "none" : getComputedStyle(el).display;
    };
    const railTimes = document.querySelector(".rail-block__time");
    return {
      actionsHidden: displayOf(".rail-block__actions") === "none",
      mapWidgetHidden: displayOf(".map-panel") === "none",
      timeFontSize: railTimes ? getComputedStyle(railTimes).fontSize : "0px",
      whyVisible: document.querySelectorAll(".rail-block__why").length,
      warningsVisible: displayOf(".day-warnings") !== "none",
    };
  })()`) as {
    actionsHidden: boolean;
    mapWidgetHidden: boolean;
    timeFontSize: string;
    whyVisible: number;
    warningsVisible: boolean;
  };

  check("interactive chrome hidden in print", chrome.actionsHidden && chrome.mapWidgetHidden);
  check("times set large", parseFloat(chrome.timeFontSize) >= 15, chrome.timeFontSize);
  check("warnings kept in print", chrome.warningsVisible);

  const pdfPath = join(outDir, "printed-trip.pdf");
  await page.pdf({ path: pdfPath, format: "A4", printBackground: false });
  const pdf = await readFile(pdfPath);
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check("one page per day (plus a cover)", pages >= 4, `${pages} pages for 3 days`);
  console.log(`  printed: ${pdfPath}`);

  await context.close();
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
