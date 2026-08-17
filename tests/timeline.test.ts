import { describe, expect, it } from "vitest";
import { buildTimeline, dayExtent, slackMinutes, travelMinutes } from "../src/client/model/timeline.js";
import { plainWhy } from "../src/client/model/why.js";
import { defaultPreferences } from "../src/shared/preferences.js";
import type { ItineraryDay, MealSlot, Poi } from "../src/shared/types.js";
import { poi } from "./helpers/synthetic.js";

/**
 * §9a — the model behind the rail. The rendered proportionality is verified in
 * a real browser by `scripts/verify-export.ts` (it is a layout fact, not a data
 * fact); what belongs here is that every block carries its true duration and
 * that the gaps between stops are accounted for rather than swallowed.
 */

function day(stops: ItineraryDay["stops"], warnings: string[] = []): ItineraryDay {
  return { dayIndex: 0, cityName: "Porto", date: "2026-09-08", stops, warnings };
}

const pois: Record<string, Poi> = {};
function register(p: Poi): Poi {
  pois[p.id] = p;
  return p;
}

const museum = register(poi({ name: "A Museum", typicalDurationMin: 120 }));
const viewpoint = register(poi({ name: "A Viewpoint", typicalDurationMin: 30 }));
const restaurant = register(poi({ name: "A Restaurant", category: "restaurant" }));

describe("buildTimeline", () => {
  it("gives every block its real duration", () => {
    const blocks = buildTimeline(
      day([
        { poiId: museum.id, arriveMin: 600, departMin: 720, travelFromPrevMin: 0, pinned: false, rationale: null },
        { poiId: viewpoint.id, arriveMin: 750, departMin: 780, travelFromPrevMin: 12, pinned: false, rationale: null },
      ]),
      [],
      pois,
      { approximateTravel: false },
    );

    const stops = blocks.filter((b) => b.kind === "stop");
    expect(stops.map((b) => b.endMin - b.startMin)).toEqual([120, 30]);
    // The 120-minute stop is four times the 30-minute one, which is exactly
    // what the rail turns into height.
    expect((stops[0].endMin - stops[0].startMin) / (stops[1].endMin - stops[1].startMin)).toBe(4);
  });

  it("accounts for the whole gap between stops, as travel then slack", () => {
    const blocks = buildTimeline(
      day([
        { poiId: museum.id, arriveMin: 600, departMin: 720, travelFromPrevMin: 0, pinned: false, rationale: null },
        { poiId: viewpoint.id, arriveMin: 750, departMin: 780, travelFromPrevMin: 12, pinned: false, rationale: null },
      ]),
      [],
      pois,
      { approximateTravel: false },
    );

    expect(travelMinutes(blocks)).toBe(12);
    expect(slackMinutes(blocks)).toBe(18);
    // Nothing is unaccounted for: the blocks tile the day end to end.
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].startMin).toBe(blocks[i - 1].endMin);
    }
  });

  it("marks travel as approximate only when the mode is estimated (§5d)", () => {
    const stops = [
      { poiId: museum.id, arriveMin: 600, departMin: 720, travelFromPrevMin: 0, pinned: false, rationale: null },
      { poiId: viewpoint.id, arriveMin: 745, departMin: 775, travelFromPrevMin: 20, pinned: false, rationale: null },
    ];
    const routed = buildTimeline(day(stops), [], pois, { approximateTravel: false });
    const estimated = buildTimeline(day(stops), [], pois, { approximateTravel: true });
    expect(routed.find((b) => b.kind === "travel")).toMatchObject({ approximate: false });
    expect(estimated.find((b) => b.kind === "travel")).toMatchObject({ approximate: true });
  });

  it("threads meals into the order without disturbing the stops", () => {
    const meals: MealSlot[] = [
      { kind: "lunch", startMin: 730, durationMin: 60, poiId: restaurant.id },
    ];
    const blocks = buildTimeline(
      day([
        { poiId: museum.id, arriveMin: 600, departMin: 720, travelFromPrevMin: 0, pinned: false, rationale: null },
        { poiId: viewpoint.id, arriveMin: 800, departMin: 830, travelFromPrevMin: 8, pinned: false, rationale: null },
      ]),
      meals,
      pois,
      { approximateTravel: false },
    );
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain("meal");
    expect(kinds.indexOf("meal")).toBeGreaterThan(kinds.indexOf("stop"));
    const meal = blocks.find((b) => b.kind === "meal");
    expect(meal && meal.kind === "meal" && meal.poi?.name).toBe("A Restaurant");
  });

  it("attaches the day's warning to the stop it names (§9d)", () => {
    const blocks = buildTimeline(
      day(
        [
          { poiId: museum.id, arriveMin: 600, departMin: 720, travelFromPrevMin: 0, pinned: false, rationale: null },
        ],
        ["Hours unconfirmed for A Museum — check before you go."],
      ),
      [],
      pois,
      { approximateTravel: false },
    );
    const stop = blocks.find((b) => b.kind === "stop");
    expect(stop && stop.kind === "stop" && stop.warning).toContain("A Museum");
  });

  it("never renders a stop it cannot name", () => {
    const blocks = buildTimeline(
      day([
        { poiId: "not-in-the-set", arriveMin: 600, departMin: 700, travelFromPrevMin: 0, pinned: false, rationale: null },
      ]),
      [],
      pois,
      { approximateTravel: false },
    );
    expect(blocks.filter((b) => b.kind === "stop")).toHaveLength(0);
  });

  it("reports the day's extent", () => {
    const blocks = buildTimeline(
      day([
        { poiId: museum.id, arriveMin: 600, departMin: 720, travelFromPrevMin: 0, pinned: false, rationale: null },
        { poiId: viewpoint.id, arriveMin: 800, departMin: 830, travelFromPrevMin: 8, pinned: false, rationale: null },
      ]),
      [],
      pois,
      { approximateTravel: false },
    );
    expect(dayExtent(blocks)).toEqual({ startMin: 600, endMin: 830 });
  });

  it("returns nothing for an empty day rather than throwing", () => {
    expect(buildTimeline(day([]), [], pois, { approximateTravel: false })).toEqual([]);
    expect(dayExtent([])).toBeNull();
  });
});

describe("the deterministic reason line (§9c without a key)", () => {
  const preferences = defaultPreferences();

  it("names the interests the place actually matched", () => {
    const p = poi({ tags: ["museums", "history"], name: "X" });
    preferences.interests.museums = 3;
    preferences.interests.history = 2;
    expect(plainWhy(p, preferences)).toBe("Matches your interest in museums and history.");
  });

  it("mentions editorial endorsement when there is one", () => {
    const p = poi({ tags: ["museums"], provenance: "wikivoyage" });
    preferences.interests.museums = 3;
    expect(plainWhy(p, preferences)).toContain("city guide");
  });

  it("says something true when nothing matched", () => {
    const p = poi({ tags: ["shopping"] });
    preferences.interests.shopping = 0;
    expect(plainWhy(p, preferences)).toBe("Near your other stops, and it fits the day.");
  });
});
