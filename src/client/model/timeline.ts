import type { ItineraryDay, MealSlot, Poi, ScheduledStop } from "../../shared/types.js";

/**
 * §9a — the day as a continuous time axis rather than a stack of cards.
 *
 * This turns a scheduled day into the ordered blocks the rail renders, and it
 * is where "the shape of the day" comes from: every block knows its real
 * duration, including the travel between stops and the slack left over. The
 * rail then gives each block a height proportional to that duration, which is
 * what uniform cards hide.
 */

export type RailBlock =
  | {
      kind: "stop";
      key: string;
      startMin: number;
      endMin: number;
      stop: ScheduledStop;
      poi: Poi;
      /** The day warning naming this stop, when there is one (§9d). */
      warning: string | null;
    }
  | {
      kind: "meal";
      key: string;
      startMin: number;
      endMin: number;
      meal: MealSlot;
      poi: Poi | null;
    }
  | {
      kind: "travel";
      key: string;
      startMin: number;
      endMin: number;
      minutes: number;
      /** True when the number is an estimate rather than a routed time (§5d). */
      approximate: boolean;
    }
  | {
      kind: "slack";
      key: string;
      startMin: number;
      endMin: number;
      minutes: number;
    };

/** Below this, a gap is just buffer and does not earn a block of its own. */
const MIN_VISIBLE_GAP_MIN = 5;

export function buildTimeline(
  day: ItineraryDay,
  meals: MealSlot[],
  pois: Record<string, Poi>,
  options: { approximateTravel: boolean },
): RailBlock[] {
  type Anchor =
    | { at: number; end: number; type: "stop"; stop: ScheduledStop }
    | { at: number; end: number; type: "meal"; meal: MealSlot };

  const anchors: Anchor[] = [
    ...day.stops.map(
      (stop): Anchor => ({ at: stop.arriveMin, end: stop.departMin, type: "stop", stop }),
    ),
    ...meals.map(
      (meal): Anchor => ({
        at: meal.startMin,
        end: meal.startMin + meal.durationMin,
        type: "meal",
        meal,
      }),
    ),
  ].sort((a, b) => a.at - b.at);

  const blocks: RailBlock[] = [];
  let cursor: number | null = null;

  for (const anchor of anchors) {
    if (cursor !== null && anchor.at > cursor) {
      const gap = anchor.at - cursor;
      const travel =
        anchor.type === "stop" ? Math.min(anchor.stop.travelFromPrevMin, gap) : 0;
      if (travel > 0) {
        blocks.push({
          kind: "travel",
          key: `travel-${cursor}`,
          startMin: cursor,
          endMin: cursor + travel,
          minutes: travel,
          approximate: options.approximateTravel,
        });
      }
      const slack = gap - travel;
      if (slack >= MIN_VISIBLE_GAP_MIN) {
        blocks.push({
          kind: "slack",
          key: `slack-${cursor + travel}`,
          startMin: cursor + travel,
          endMin: anchor.at,
          minutes: slack,
        });
      }
    }

    if (anchor.type === "stop") {
      const poi = pois[anchor.stop.poiId];
      if (!poi) continue; // never render a stop we cannot name
      blocks.push({
        kind: "stop",
        key: `stop-${anchor.stop.poiId}-${anchor.at}`,
        startMin: anchor.at,
        endMin: anchor.end,
        stop: anchor.stop,
        poi,
        warning: day.warnings.find((w) => w.includes(poi.name)) ?? null,
      });
    } else {
      blocks.push({
        kind: "meal",
        key: `meal-${anchor.meal.kind}-${anchor.at}`,
        startMin: anchor.at,
        endMin: anchor.end,
        meal: anchor.meal,
        poi: anchor.meal.poiId ? (pois[anchor.meal.poiId] ?? null) : null,
      });
    }
    cursor = Math.max(cursor ?? 0, anchor.end);
  }

  return blocks;
}

/** First and last minute the day occupies, for the rail's own extent. */
export function dayExtent(blocks: RailBlock[]): { startMin: number; endMin: number } | null {
  if (blocks.length === 0) return null;
  return {
    startMin: blocks[0].startMin,
    endMin: Math.max(...blocks.map((b) => b.endMin)),
  };
}

/** Total walking-and-riding time in the day, for the day's summary line. */
export function travelMinutes(blocks: RailBlock[]): number {
  return blocks.reduce((sum, b) => sum + (b.kind === "travel" ? b.minutes : 0), 0);
}

/** How much of the day is unscheduled — the visible air §9a is about. */
export function slackMinutes(blocks: RailBlock[]): number {
  return blocks.reduce((sum, b) => sum + (b.kind === "slack" ? b.minutes : 0), 0);
}
