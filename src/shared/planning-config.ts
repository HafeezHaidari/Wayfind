/**
 * Every tunable number the scheduler (§7) reads, in one place. §6a makes the
 * same demand of the scoring weights, which live in src/shared/scoring-config.ts.
 * Named constants, no magic numbers inline: these need tuning and tuning is
 * impossible when they are scattered.
 */

import type { Preferences } from "./types.js";

/** §3: target stops per day, by pace. */
export const PACE_TARGETS: Record<Preferences["pace"], { min: number; max: number }> = {
  relaxed: { min: 2, max: 3 },
  moderate: { min: 4, max: 5 },
  packed: { min: 6, max: 7 },
};

/** §3: 07:00 / 09:30 / 11:00, in minutes from midnight. */
export const DAY_START_MIN: Record<Preferences["dayStart"], number> = {
  early: 7 * 60,
  midmorning: 9 * 60 + 30,
  late: 11 * 60,
};

/** §3: 18:00 / 21:00 / late-night. */
export const DAY_END_MIN: Record<Preferences["dayEnd"], number> = {
  early: 18 * 60,
  moderate: 21 * 60,
  late: 23 * 60 + 30,
};

/** §7d: cap on total daily walking, in metres, by mobility preference. */
export const DAILY_WALK_CAP_M: Record<Preferences["mobility"], number> = {
  "lots-of-walking-fine": 12000,
  moderate: 7000,
  "minimal-walking": 2500,
};

/**
 * §7d: slack left between stops so the plan survives anything running long.
 * A plan scheduled to the minute is wrong the moment it meets a queue.
 */
export const BUFFER_BETWEEN_STOPS_MIN = 10;

/** §7a step 1: over-select so the layout pass has room to drop. */
export const OVERSELECT_FACTOR = 1.5;

/** §7d: never shrink a stop below this fraction of its typical duration. */
export const MIN_DURATION_FRACTION = 0.6;

/** §7d: absolute floor, whatever the category says. No 12-minute museums. */
export const ABSOLUTE_MIN_STOP_MIN = 20;

// --- Meals (§7b) -------------------------------------------------------------

/** The window a lunch break must start inside, in minutes from midnight. */
export const LUNCH_WINDOW = { earliest: 11 * 60 + 30, latest: 14 * 60 + 30 };
export const DINNER_WINDOW = { earliest: 18 * 60, latest: 21 * 60 };

/** Break length by `foodImportance`, in minutes. Index is the 0-3 value. */
export const LUNCH_DURATION_MIN = [30, 45, 60, 75];
export const DINNER_DURATION_MIN = [45, 60, 90, 110];

/**
 * At or above this `foodImportance`, the meal slot gets a real ranked food POI
 * rather than unprescribed reserved time (§7b).
 */
export const NAMED_MEAL_MIN_IMPORTANCE = 2;

// --- Travel (§5d) ------------------------------------------------------------

/** Walking speed used when no routed matrix is available, metres per minute. */
export const WALK_SPEED_M_PER_MIN = 75;

/**
 * §5d: transit is not really routed. Applying a multiplier to walking time with
 * a floor for waiting and interchange is honest; a fake-precise GTFS-less
 * "transit time" is not. The UI labels these estimates approximate.
 */
export const TRANSIT_MULTIPLIER = 0.45;
export const TRANSIT_FLOOR_MIN = 12;

/** Taxi and car: faster than walking but with a pickup/parking floor. */
export const TAXI_MULTIPLIER = 0.25;
export const TAXI_FLOOR_MIN = 8;
export const CAR_MULTIPLIER = 0.3;
export const CAR_FLOOR_MIN = 10;

/** Below this walking time, every mode just walks; nobody hails a cab for 300m. */
export const SHORT_HOP_WALK_MIN = 8;

// --- Clustering (§7a step 2) -------------------------------------------------

/** k-means restarts; the objective is noisy and restarts are nearly free here. */
export const KMEANS_RESTARTS = 8;
export const KMEANS_MAX_ITERATIONS = 60;

/**
 * How strongly a supplied basecamp pulls day clusters toward it. 0 disables the
 * bias, 1 would collapse every cluster onto the hotel.
 */
export const BASECAMP_BIAS = 0.25;

// --- Sequencing (§7a step 4) -------------------------------------------------

export const TWO_OPT_MAX_PASSES = 40;

// --- Opening hours (§7c) -----------------------------------------------------

/**
 * A visit must fit inside the open window by at least this much, so we do not
 * send someone through the door four minutes before closing.
 */
export const CLOSING_MARGIN_MIN = 15;
