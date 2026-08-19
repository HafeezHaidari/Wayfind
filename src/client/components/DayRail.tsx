import type { Pin, Poi, Preferences } from "../../shared/types.js";
import { formatClock, formatDuration } from "../../shared/dates.js";
import { CATEGORY_BY_KEY } from "../../shared/categories.js";
import type { RailBlock } from "../model/timeline.js";
import { plainWhy } from "../model/why.js";

/**
 * §9a — the proportional time rail.
 *
 * A vertical axis runs down the left. Every block's height is proportional to
 * its actual duration, travel is a literal hairline-ruled gap, and meals are
 * blocks too. This is the one place to spend effort, because it encodes
 * something true that uniform cards actively hide: the shape of the day.
 */

type Props = {
  blocks: RailBlock[];
  transportLabel: string;
  hoveredPoiId: string | null;
  onHover: (poiId: string | null) => void;
  onRemove: (poiId: string) => void;
  onPin: (poiId: string, arriveMin: number | null) => void;
  onUnpin: (poiId: string) => void;
  pins: Pin[];
  dayIndex: number;
  preferences: Preferences;
};

export default function DayRail({
  blocks,
  transportLabel,
  hoveredPoiId,
  onHover,
  onRemove,
  onPin,
  onUnpin,
  pins,
  dayIndex,
  preferences,
}: Props) {
  if (blocks.length === 0) {
    return (
      <div className="notice rail-empty">
        <p className="notice__title">Nothing fits this day</p>
        <p className="notice__body">
          Everything Wayfind found for this day is closed, too far, or already scheduled elsewhere.
          Try widening your interests, or pull something in from the alternatives below.
        </p>
      </div>
    );
  }

  return (
    <ol className="rail">
      {blocks.map((block) => {
        switch (block.kind) {
          case "stop":
            return (
              <StopBlock
                key={block.key}
                block={block}
                hovered={hoveredPoiId === block.poi.id}
                onHover={onHover}
                onRemove={onRemove}
                onPin={onPin}
                onUnpin={onUnpin}
                pin={pins.find((p) => p.poiId === block.poi.id) ?? null}
                dayIndex={dayIndex}
                preferences={preferences}
              />
            );
          case "meal":
            return <MealBlock key={block.key} block={block} />;
          case "travel":
            return <TravelBlock key={block.key} block={block} transportLabel={transportLabel} />;
          case "slack":
            return <SlackBlock key={block.key} block={block} />;
        }
      })}
    </ol>
  );
}

/** Duration in minutes becomes height in pixels. This is the whole idea (§9a). */
function heightFor(block: RailBlock): React.CSSProperties {
  return { "--block-minutes": block.endMin - block.startMin } as React.CSSProperties;
}

function StopBlock({
  block,
  hovered,
  onHover,
  onRemove,
  onPin,
  onUnpin,
  pin,
  dayIndex,
  preferences,
}: {
  block: Extract<RailBlock, { kind: "stop" }>;
  hovered: boolean;
  onHover: (poiId: string | null) => void;
  onRemove: (poiId: string) => void;
  onPin: (poiId: string, arriveMin: number | null) => void;
  onUnpin: (poiId: string) => void;
  pin: Pin | null;
  dayIndex: number;
  preferences: Preferences;
}) {
  const { poi, stop } = block;
  const duration = block.endMin - block.startMin;
  const category = poi.category ? CATEGORY_BY_KEY[poi.category].label : "Place";

  return (
    <li
      className="rail-block rail-block--stop"
      style={heightFor(block)}
      data-pinned={stop.pinned || undefined}
      data-caution={block.warning ? true : undefined}
      data-hovered={hovered || undefined}
      data-poi-id={poi.id}
      onMouseEnter={() => onHover(poi.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(poi.id)}
      onBlur={() => onHover(null)}
      tabIndex={0}
    >
      <div className="rail-block__spine">
        <time className="rail-block__time mono">{formatClock(stop.arriveMin)}</time>
        <span className="rail-block__duration mono">{formatDuration(duration)}</span>
        {/* The block's foot carries its end time, so its height reads as a span. */}
        <time className="rail-block__until mono">{formatClock(stop.departMin)}</time>
      </div>

      <div className="rail-block__body">
        <div className="rail-block__head">
          <h3 className="rail-block__name place-name">{poi.name}</h3>
          {/* The name as it appears on the door, for pointing at (§9g). */}
          {poi.localName && <span className="rail-block__local">{poi.localName}</span>}
          {stop.pinned && <span className="tag tag--locked">Pinned</span>}
        </div>

        {stop.rationale ? (
          <p className="rail-block__why">{stop.rationale}</p>
        ) : (
          <p className="rail-block__why rail-block__why--plain">{plainWhy(poi, preferences)}</p>
        )}

        {/*
          The meta row is pinned to the foot of the block so it survives on the
          shortest blocks the scale produces. §9d's "hours unconfirmed" label
          rides here rather than on its own line for the same reason: on a
          30-minute stop a separate line was being clipped, and a warning you
          cannot see is not a warning.
        */}
        <p className="rail-block__meta">
          <span className="rail-block__category">{category}</span>
          {poi.priceTier !== null && (
            <>
              <span aria-hidden="true"> · </span>
              <span>{priceLabel(poi.priceTier)}</span>
            </>
          )}
          <span aria-hidden="true"> · </span>
          <span className="mono">
            {formatClock(stop.arriveMin)}–{formatClock(stop.departMin)}
          </span>
          {block.warning && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="rail-block__caution">Hours unconfirmed</span>
            </>
          )}
        </p>

        <div className="rail-block__actions no-print">
          {pin ? (
            <button className="btn btn--quiet btn--small" onClick={() => onUnpin(poi.id)}>
              Unpin
            </button>
          ) : (
            <>
              <button
                className="btn btn--quiet btn--small"
                onClick={() => onPin(poi.id, null)}
                title={`Keep ${poi.name} on day ${dayIndex + 1}`}
              >
                Pin to this day
              </button>
              <button
                className="btn btn--quiet btn--small"
                onClick={() => onPin(poi.id, stop.arriveMin)}
                title={`Keep ${poi.name} at ${formatClock(stop.arriveMin)}`}
              >
                Pin to {formatClock(stop.arriveMin)}
              </button>
            </>
          )}
          <button className="btn btn--quiet btn--small" onClick={() => onRemove(poi.id)}>
            Remove
          </button>
        </div>
      </div>
    </li>
  );
}

function MealBlock({ block }: { block: Extract<RailBlock, { kind: "meal" }> }) {
  const duration = block.endMin - block.startMin;
  const label = block.meal.kind === "lunch" ? "Lunch" : "Dinner";
  return (
    <li className="rail-block rail-block--meal" style={heightFor(block)}>
      <div className="rail-block__spine">
        <time className="rail-block__time mono">{formatClock(block.startMin)}</time>
        <span className="rail-block__duration mono">{formatDuration(duration)}</span>
      </div>
      <div className="rail-block__body">
        <h3 className="rail-block__name place-name">
          {block.poi ? block.poi.name : label}
          {block.poi?.localName && <span className="rail-block__local">{block.poi.localName}</span>}
        </h3>
        <p className="rail-block__meta">
          {block.poi ? `${label} · a table you'll want to book` : `${label} · time held, pick as you go`}
        </p>
      </div>
    </li>
  );
}

function TravelBlock({
  block,
  transportLabel,
}: {
  block: Extract<RailBlock, { kind: "travel" }>;
  transportLabel: string;
}) {
  return (
    <li className="rail-block rail-block--travel" style={heightFor(block)}>
      <div className="rail-block__spine" />
      <p className="rail-block__travel mono">
        {block.approximate ? "≈" : ""}
        {block.minutes} min {transportLabel}
      </p>
    </li>
  );
}

/** Past this, the gap is capped and marked rather than drawn to scale. */
const SLACK_CAP_MIN = 42;

function SlackBlock({ block }: { block: Extract<RailBlock, { kind: "slack" }> }) {
  return (
    <li
      className="rail-block rail-block--slack"
      style={heightFor(block)}
      data-capped={block.minutes > SLACK_CAP_MIN || undefined}
    >
      <div className="rail-block__spine" />
      <p className="rail-block__slack mono">{formatDuration(block.minutes)} free</p>
    </li>
  );
}

function priceLabel(tier: 0 | 1 | 2 | 3): string {
  return ["Free", "Cheap", "Mid-priced", "Pricey"][tier];
}

