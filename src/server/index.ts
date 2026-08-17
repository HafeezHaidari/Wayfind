import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { info, errorAt } from "./log.js";
import { geocodeCity } from "./pipeline/geocode.js";
import { generateItinerary } from "./pipeline/generate.js";
import { listFixtureCities } from "./pipeline/fixtures.js";

/**
 * A stateless pipeline: brief in, itinerary out (§1). Nothing is written to
 * disk, nothing is kept between requests except the process-lifetime POI cache
 * permitted by §5e, which holds third-party data only.
 */
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    fixtureMode: env.fixtureMode,
    rationaleEnabled: env.enableRationale,
    llmConfigured: env.anthropicKey !== null,
    fixtureCities: listFixtureCities(),
  });
});

app.get("/api/geocode", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.status(400).json({ error: "Give a city name to look up." });
    return;
  }
  try {
    res.json({ results: await geocodeCity(q) });
  } catch (err) {
    errorAt("geocode", err);
    res.status(502).json({
      error: "The place lookup service didn't answer. Try again in a moment.",
      stage: "geocode",
    });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const itinerary = await generateItinerary(req.body);
    res.json(itinerary);
  } catch (err) {
    // §11c: never swallow an exception and return an empty success.
    errorAt("generate", err);
    const message =
      err instanceof Error ? err.message : "Something went wrong building the itinerary.";
    res.status(502).json({ error: message, stage: "generate" });
  }
});

app.listen(env.port, () => {
  info(`server on :${env.port}`, {
    fixtureMode: env.fixtureMode,
    llm: env.anthropicKey ? "configured" : "absent",
    rationale: env.enableRationale,
  });
});
