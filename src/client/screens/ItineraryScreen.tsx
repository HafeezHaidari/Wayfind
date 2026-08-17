import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InterestTag, Itinerary, Pin, Preferences, TripBrief } from "../../shared/types.js";
import { formatDayLabel, formatDuration } from "../../shared/dates.js";
import { INTEREST_LABELS } from "../../shared/interests.js";
import { CATEGORY_BY_KEY } from "../../shared/categories.js";
import { generate, ApiError } from "../api.js";
import { buildTimeline, slackMinutes, travelMinutes, type RailBlock } from "../model/timeline.js";
import DayRail from "../components/DayRail.js";
import MapPanel from "../components/MapPanel.js";

/**
 * §9i — the itinerary screen: day tabs, the time rail, the synced map, the
 * day's warnings, and the alternatives panel. §8 lives here too: every
 * refinement re-runs the scheduler against the cached candidate set rather than
 * re-sourcing (§5e), so editing is fast.
 */

type Props = {
  brief: TripBrief;
  onChangeBrief: (brief: TripBrief) => void;
  itinerary: Itinerary | null;
  onItinerary: (itinerary: Itinerary | null) => void;
  pins: Pin[];
  onPins: (pins: Pin[]) => void;
  onEditTrip: () => void;
  onEditPreferences: () => void;
  onExport: () => void;
};

const TRANSPORT_LABEL: Record<Preferences["transport"], string> = {
  walk: "walk",
  transit: "by transit",
  taxi: "by taxi",
  car: "drive",
};

export default function ItineraryScreen({
  brief,
  onChangeBrief,
  itinerary,
  onItinerary,
  pins,
  onPins,
  onEditTrip,
  onEditPreferences,
  onExport,
}: Props) {
  const [cityIndex, setCityIndex] = useState(0);
  const [dayIndex, setDayIndex] = useState(0);
  const [hoveredPoiId, setHoveredPoiId] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);
  const railRef = useRef<HTMLDivElement | null>(null);

  const run = useCallback(
    async (next: { brief: TripBrief; pins: Pin[]; removedPoiIds: string[]; reuse: boolean }) => {
      setStatus("working");
      setError(null);
      try {
        const result = await generate({
          brief: next.brief,
          pins: next.pins,
          removedPoiIds: next.removedPoiIds,
          reuseCandidates: next.reuse,
        });
        onItinerary(result);
        setStatus("idle");
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.message
            : "Something went wrong building the itinerary. Try again.",
        );
        setStatus("error");
      }
    },
    [onItinerary],
  );

  // Generate once on arrival; refinements are explicit from here on.
  useEffect(() => {
    if (itinerary === null && status === "idle") {
      void run({ brief, pins, removedPoiIds: removed, reuse: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refine = useCallback(
    (changes: { brief?: TripBrief; pins?: Pin[]; removed?: string[] }) => {
      const nextBrief = changes.brief ?? brief;
      const nextPins = changes.pins ?? pins;
      const nextRemoved = changes.removed ?? removed;
      if (changes.brief) onChangeBrief(changes.brief);
      if (changes.pins) onPins(changes.pins);
      if (changes.removed) setRemoved(changes.removed);
      void run({ brief: nextBrief, pins: nextPins, removedPoiIds: nextRemoved, reuse: true });
    },
    [brief, pins, removed, onChangeBrief, onPins, run],
  );

  const city = itinerary?.cities[cityIndex] ?? null;
  const day = city?.days[Math.min(dayIndex, city.days.length - 1)] ?? null;

  const blocks: RailBlock[] = useMemo(() => {
    if (!itinerary || !city || !day) return [];
    return buildTimeline(day, city.meals[day.dayIndex] ?? [], itinerary.pois, {
      approximateTravel: brief.preferences.transport !== "walk",
    });
  }, [itinerary, city, day, brief.preferences.transport]);

  const mapStops = useMemo(
    () =>
      blocks
        .filter((b): b is Extract<RailBlock, { kind: "stop" }> => b.kind === "stop")
        .map((b, i) => ({ poi: b.poi, label: String(i + 1) })),
    [blocks],
  );

  const scrollToStop = useCallback((poiId: string) => {
    const element = railRef.current?.querySelector(`[data-poi-id="${CSS.escape(poiId)}"]`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHoveredPoiId(poiId);
  }, []);

  // --- refinement actions (§8) ----------------------------------------------

  const removeStop = (poiId: string) => refine({ removed: [...removed, poiId] });

  const pinStop = (poiId: string, arriveMin: number | null) =>
    refine({
      pins: [
        ...pins.filter((p) => p.poiId !== poiId),
        { poiId, dayIndex: day?.dayIndex ?? 0, arriveMin },
      ],
    });

  const unpinStop = (poiId: string) => refine({ pins: pins.filter((p) => p.poiId !== poiId) });

  const swapIn = (poiId: string) =>
    refine({
      removed: removed.filter((id) => id !== poiId),
      pins: [
        ...pins.filter((p) => p.poiId !== poiId),
        { poiId, dayIndex: day?.dayIndex ?? 0, arriveMin: null },
      ],
    });

  const nudgeInterest = (tag: InterestTag, direction: 1 | -1) => {
    const level = Math.max(0, Math.min(3, (brief.preferences.interests[tag] ?? 1) + direction));
    refine({
      brief: {
        ...brief,
        preferences: {
          ...brief.preferences,
          interests: { ...brief.preferences.interests, [tag]: level as 0 | 1 | 2 | 3 },
        },
      },
    });
  };

  const setPace = (pace: Preferences["pace"]) =>
    refine({ brief: { ...brief, preferences: { ...brief.preferences, pace } } });

  // --- render ----------------------------------------------------------------

  if (status === "working" && !itinerary) {
    return (
      <main className="page page--wide">
        <p className="eyebrow">Working</p>
        <h1 className="page__title">Building your itinerary</h1>
        <p className="page__lede">
          Finding places, checking when they're open, and laying out the days. This takes a few
          seconds the first time — after that, changes are instant.
        </p>
      </main>
    );
  }

  if (status === "error" && !itinerary) {
    return (
      <main className="page">
        <p className="eyebrow">Stopped</p>
        <h1 className="page__title">That didn't work</h1>
        <div className="notice notice--caution">
          <p className="notice__body">{error}</p>
        </div>
        <div className="actions" style={{ marginTop: "1.5rem" }}>
          <button
            className="btn btn--primary"
            onClick={() => void run({ brief, pins, removedPoiIds: removed, reuse: false })}
          >
            Try again
          </button>
          <button className="btn" onClick={onEditTrip}>
            Back to the trip
          </button>
        </div>
      </main>
    );
  }

  if (!itinerary || !city || !day) return null;

  const dayBlocks = blocks;
  const stopCount = dayBlocks.filter((b) => b.kind === "stop").length;
  const walking = travelMinutes(dayBlocks);
  const slack = slackMinutes(dayBlocks);
  const dayAlternatives = city.dropped
    .filter((d) => d.dayIndex === null || d.dayIndex === day.dayIndex)
    .slice(0, 8);

  return (
    <main className="page page--wide">
      <header className="itinerary-head no-print">
        <div>
          <p className="eyebrow">{brief.name.trim() || "Your trip"}</p>
          <h1 className="page__title">{city.cityName}</h1>
        </div>
        <div className="actions">
          {itinerary.cities.length > 1 && (
            <div className="choices choices--compact">
              {itinerary.cities.map((c, i) => (
                <button
                  key={c.cityName}
                  className="btn btn--small"
                  aria-pressed={i === cityIndex}
                  onClick={() => {
                    setCityIndex(i);
                    setDayIndex(0);
                  }}
                >
                  {c.cityName}
                </button>
              ))}
            </div>
          )}
          <button className="btn btn--small" onClick={onEditPreferences}>
            Preferences
          </button>
          <button className="btn btn--small btn--primary" onClick={onExport}>
            Export
          </button>
        </div>
      </header>

      {itinerary.notes.length > 0 && (
        <div className="notice no-print itinerary-notes">
          <p className="notice__title">Worth knowing</p>
          <ul className="notice__body">
            {itinerary.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      <nav className="day-tabs no-print" aria-label="Days">
        {city.days.map((d, i) => (
          <button
            key={d.dayIndex}
            className="day-tab"
            role="tab"
            aria-selected={i === dayIndex}
            data-caution={d.warnings.length > 0}
            onClick={() => setDayIndex(i)}
          >
            <span className="day-tab__index">Day {i + 1}</span>
            <span className="day-tab__date">{formatDayLabel(d.date) ?? `Day ${i + 1}`}</span>
            <span className="day-tab__count">
              {d.stops.length} {d.stops.length === 1 ? "stop" : "stops"}
            </span>
          </button>
        ))}
      </nav>

      <div className="itinerary-layout">
        <section className="itinerary-rail" ref={railRef}>
          <div className="day-heading print-only">
            <h2 className="page__title">
              {city.cityName} — {formatDayLabel(day.date) ?? `Day ${day.dayIndex + 1}`}
            </h2>
          </div>

          <p className="day-summary">
            <span>
              {stopCount} {stopCount === 1 ? "stop" : "stops"}
            </span>
            <span>{formatDuration(walking)} moving</span>
            <span>{formatDuration(slack)} free</span>
            {status === "working" && <span aria-live="polite">Rescheduling…</span>}
          </p>

          <button
            className="btn btn--small map-toggle"
            onClick={() => setMapExpanded((v) => !v)}
            aria-expanded={mapExpanded}
          >
            {mapExpanded ? "Hide map" : "Show map"}
          </button>

          <DayRail
            blocks={dayBlocks}
            transportLabel={TRANSPORT_LABEL[brief.preferences.transport]}
            hoveredPoiId={hoveredPoiId}
            onHover={setHoveredPoiId}
            onRemove={removeStop}
            onPin={pinStop}
            onUnpin={unpinStop}
            pins={pins}
            dayIndex={day.dayIndex}
            preferences={brief.preferences}
          />

          {day.warnings.length > 0 && (
            <section className="day-warnings">
              <p className="day-warnings__title">Worth checking before you go</p>
              <ul>
                {day.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          <PaceControls
            pace={brief.preferences.pace}
            onSetPace={setPace}
            blocks={dayBlocks}
            onNudge={nudgeInterest}
            disabled={status === "working"}
          />

          {dayAlternatives.length > 0 && (
            <section className="alternatives no-print">
              <h2 className="alternatives__title">Also considered</h2>
              <p className="alternatives__lede">
                These didn't make the day. Swap one in and Wayfind rebuilds around it.
              </p>
              <ul className="alternatives__list">
                {dayAlternatives.map((entry) => {
                  const poi = itinerary.pois[entry.poiId];
                  if (!poi) return null;
                  return (
                    <li key={entry.poiId} className="alternative">
                      <div>
                        <p className="alternative__name">{poi.name}</p>
                        <p className="alternative__why">
                          {entry.reason}
                          {poi.category ? ` · ${CATEGORY_BY_KEY[poi.category].label}` : ""}
                        </p>
                      </div>
                      <div className="actions">
                        <span className="alternative__score">
                          {relativeScore(entry.score, dayBlocks, itinerary)}
                        </span>
                        <button
                          className="btn btn--small"
                          disabled={status === "working"}
                          onClick={() => swapIn(entry.poiId)}
                        >
                          Add to this day
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </section>

        <aside data-expanded={mapExpanded}>
          <MapPanel
            stops={mapStops}
            hoveredPoiId={hoveredPoiId}
            onHover={setHoveredPoiId}
            onSelect={scrollToStop}
            basecamp={
              brief.cities[cityIndex]?.basecampLat != null &&
              brief.cities[cityIndex]?.basecampLng != null
                ? {
                    lat: brief.cities[cityIndex].basecampLat as number,
                    lng: brief.cities[cityIndex].basecampLng as number,
                  }
                : null
            }
          />
        </aside>
      </div>

      {error && (
        <div className="notice notice--caution no-print" style={{ marginTop: "1.5rem" }}>
          <p className="notice__body">{error}</p>
        </div>
      )}
    </main>
  );
}

/** §8 — "more of this / less of this", and pace, without leaving the itinerary. */
function PaceControls({
  pace,
  onSetPace,
  blocks,
  onNudge,
  disabled,
}: {
  pace: Preferences["pace"];
  onSetPace: (pace: Preferences["pace"]) => void;
  blocks: RailBlock[];
  onNudge: (tag: InterestTag, direction: 1 | -1) => void;
  disabled: boolean;
}) {
  // Offer nudges for what is actually on this day, not the whole tag list.
  const tags = new Set<InterestTag>();
  for (const block of blocks) {
    if (block.kind === "stop") for (const tag of block.poi.tags) tags.add(tag);
  }
  const shown = [...tags].slice(0, 5);

  return (
    <section className="refine no-print">
      <div className="refine__group">
        <p className="field-label">Pace</p>
        <div className="choices choices--compact">
          {(["relaxed", "moderate", "packed"] as const).map((option) => (
            <button
              key={option}
              className="btn btn--small"
              aria-pressed={pace === option}
              disabled={disabled}
              onClick={() => onSetPace(option)}
            >
              {option[0].toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {shown.length > 0 && (
        <div className="refine__group">
          <p className="field-label">More or less of</p>
          <ul className="refine__tags">
            {shown.map((tag) => (
              <li key={tag} className="refine__tag">
                <span>{INTEREST_LABELS[tag]}</span>
                <button
                  className="btn btn--quiet btn--small"
                  disabled={disabled}
                  onClick={() => onNudge(tag, 1)}
                  aria-label={`More ${INTEREST_LABELS[tag]}`}
                >
                  More
                </button>
                <button
                  className="btn btn--quiet btn--small"
                  disabled={disabled}
                  onClick={() => onNudge(tag, -1)}
                  aria-label={`Less ${INTEREST_LABELS[tag]}`}
                >
                  Less
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** §9e: show the alternative's score relative to what was scheduled. */
function relativeScore(score: number, blocks: RailBlock[], itinerary: Itinerary): string {
  const scheduled = blocks
    .filter((b): b is Extract<RailBlock, { kind: "stop" }> => b.kind === "stop")
    .map((b) => itinerary.pois[b.poi.id]?.score ?? 0);
  if (scheduled.length === 0) return "";
  const average = scheduled.reduce((a, b) => a + b, 0) / scheduled.length;
  const delta = score - average;
  if (Math.abs(delta) < 0.75) return "about as good";
  return delta > 0 ? "scored higher" : "scored lower";
}
