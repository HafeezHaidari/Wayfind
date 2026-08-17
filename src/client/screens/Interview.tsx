import { useMemo, useState } from "react";
import type { InterestLevel, InterestTag, Preferences, TripBrief } from "../../shared/types.js";
import { INTEREST_GROUPS, INTEREST_LABELS, INTEREST_LEVEL_LABELS } from "../../shared/interests.js";

/**
 * §4 — structured questions, not a chat. Every field has a default, so the
 * whole interview is skippable and generation never blocks on an unanswered
 * question. Order and grouping follow §4 exactly.
 */

type Props = {
  brief: TripBrief;
  onChange: (brief: TripBrief) => void;
  onBack: () => void;
  onDone: () => void;
};

const STEPS = [
  "Pace",
  "Rhythm",
  "Interests",
  "Food",
  "Getting around",
  "Budget",
  "Who's coming",
  "Crowds",
  "Anything else",
] as const;

export default function Interview({ brief, onChange, onBack, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [dietary, setDietary] = useState("");
  const [extra, setExtra] = useState(brief.freeText ?? "");

  const prefs = brief.preferences;
  const setPrefs = (patch: Partial<Preferences>) =>
    onChange({ ...brief, preferences: { ...prefs, ...patch } });

  const finish = () => {
    const parts = [dietary.trim() && `Dietary: ${dietary.trim()}`, extra.trim()].filter(Boolean);
    onChange({ ...brief, freeText: parts.length ? parts.join("\n") : null });
    onDone();
  };

  const isLast = step === STEPS.length - 1;

  return (
    <main className="page">
      <ProgressRail step={step} onJump={setStep} />

      <div className="interview__question">
        {step === 0 && <PaceStep prefs={prefs} setPrefs={setPrefs} />}
        {step === 1 && <RhythmStep prefs={prefs} setPrefs={setPrefs} />}
        {step === 2 && <InterestsStep prefs={prefs} setPrefs={setPrefs} />}
        {step === 3 && (
          <FoodStep prefs={prefs} setPrefs={setPrefs} dietary={dietary} setDietary={setDietary} />
        )}
        {step === 4 && <GettingAroundStep prefs={prefs} setPrefs={setPrefs} />}
        {step === 5 && <BudgetStep prefs={prefs} setPrefs={setPrefs} />}
        {step === 6 && <CompanyStep prefs={prefs} setPrefs={setPrefs} />}
        {step === 7 && <CrowdsStep prefs={prefs} setPrefs={setPrefs} />}
        {step === 8 && <ExtraStep extra={extra} setExtra={setExtra} />}
      </div>

      <div className="actions actions--split interview__nav">
        <button
          className="btn btn--quiet"
          onClick={() => (step === 0 ? onBack() : setStep(step - 1))}
        >
          ← {step === 0 ? "Back to cities" : STEPS[step - 1]}
        </button>
        <div className="actions">
          <button className="btn btn--quiet" onClick={finish}>
            Skip the rest
          </button>
          <button
            className="btn btn--primary"
            onClick={() => (isLast ? finish() : setStep(step + 1))}
          >
            {isLast ? "Build the itinerary" : `Next: ${STEPS[step + 1]}`}
          </button>
        </div>
      </div>
    </main>
  );
}

function ProgressRail({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  return (
    <nav className="interview__progress" aria-label="Interview progress">
      <p className="eyebrow">
        Question {step + 1} of {STEPS.length}
      </p>
      <ol className="interview__ticks">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              className="interview__tick"
              aria-current={i === step ? "step" : undefined}
              data-done={i < step}
              onClick={() => onJump(i)}
            >
              <span className="visually-hidden">{label}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Question({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <h1 className="page__title">{title}</h1>
      {hint && <p className="page__lede">{hint}</p>}
      <div className="stack">{children}</div>
    </>
  );
}

type StepProps = { prefs: Preferences; setPrefs: (patch: Partial<Preferences>) => void };

function Choice<T extends string>({
  value,
  current,
  label,
  note,
  onPick,
}: {
  value: T;
  current: T;
  label: string;
  note?: string;
  onPick: (v: T) => void;
}) {
  return (
    <button className="choice" aria-pressed={current === value} onClick={() => onPick(value)}>
      <span className="choice__label">{label}</span>
      {note && <span className="choice__note">{note}</span>}
    </button>
  );
}

function PaceStep({ prefs, setPrefs }: StepProps) {
  return (
    <Question title="How full do you want your days?" hint="You can change this later, per day.">
      <div className="choices">
        <Choice
          value="relaxed"
          current={prefs.pace}
          label="Relaxed"
          note="Two or three stops, room to linger"
          onPick={(pace) => setPrefs({ pace })}
        />
        <Choice
          value="moderate"
          current={prefs.pace}
          label="Moderate"
          note="Four or five stops"
          onPick={(pace) => setPrefs({ pace })}
        />
        <Choice
          value="packed"
          current={prefs.pace}
          label="Packed"
          note="Six or seven stops, moving all day"
          onPick={(pace) => setPrefs({ pace })}
        />
      </div>
    </Question>
  );
}

function RhythmStep({ prefs, setPrefs }: StepProps) {
  return (
    <Question title="When do your days start and end?">
      <div className="stack--tight">
        <p className="field-label">Out of the door by</p>
        <div className="choices">
          <Choice
            value="early"
            current={prefs.dayStart}
            label="Early"
            note="07:00"
            onPick={(dayStart) => setPrefs({ dayStart })}
          />
          <Choice
            value="midmorning"
            current={prefs.dayStart}
            label="Mid-morning"
            note="09:30"
            onPick={(dayStart) => setPrefs({ dayStart })}
          />
          <Choice
            value="late"
            current={prefs.dayStart}
            label="Late"
            note="11:00"
            onPick={(dayStart) => setPrefs({ dayStart })}
          />
        </div>
      </div>
      <div className="stack--tight">
        <p className="field-label">Wrapping up around</p>
        <div className="choices">
          <Choice
            value="early"
            current={prefs.dayEnd}
            label="Early evening"
            note="18:00"
            onPick={(dayEnd) => setPrefs({ dayEnd })}
          />
          <Choice
            value="moderate"
            current={prefs.dayEnd}
            label="After dinner"
            note="21:00"
            onPick={(dayEnd) => setPrefs({ dayEnd })}
          />
          <Choice
            value="late"
            current={prefs.dayEnd}
            label="Late night"
            note="Until it's over"
            onPick={(dayEnd) => setPrefs({ dayEnd })}
          />
        </div>
      </div>
    </Question>
  );
}

/**
 * §4 calls this the highest-signal question in the interview and asks for the
 * most screen space, so it gets the full width and four explicit tap states
 * rather than a slider.
 */
function InterestsStep({ prefs, setPrefs }: StepProps) {
  const cycle = (tag: InterestTag) => {
    const next = ((prefs.interests[tag] + 1) % 4) as InterestLevel;
    setPrefs({ interests: { ...prefs.interests, [tag]: next } });
  };
  const set = (tag: InterestTag, level: InterestLevel) =>
    setPrefs({ interests: { ...prefs.interests, [tag]: level } });

  const counts = useMemo(() => {
    const mustDo = Object.values(prefs.interests).filter((v) => v === 3).length;
    const avoided = Object.values(prefs.interests).filter((v) => v === 0).length;
    return { mustDo, avoided };
  }, [prefs.interests]);

  return (
    <Question
      title="What are you here for?"
      hint="Tap once for interested, again for must-do, again to rule it out. This is what the plan is built from, so it's worth a moment."
    >
      <div className="interest-legend eyebrow">
        {INTEREST_LEVEL_LABELS.map((label, i) => (
          <span key={label} className="interest-legend__item">
            <span className="interest-swatch" data-level={i} aria-hidden="true" />
            {label}
          </span>
        ))}
      </div>

      {INTEREST_GROUPS.map((group) => (
        <div key={group.title} className="stack--tight">
          <p className="field-label">{group.title}</p>
          <div className="interest-grid">
            {group.tags.map((tag) => (
              <button
                key={tag}
                className="interest"
                data-level={prefs.interests[tag]}
                onClick={() => cycle(tag)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  set(tag, 0);
                }}
                aria-label={`${INTEREST_LABELS[tag]}: ${INTEREST_LEVEL_LABELS[prefs.interests[tag]]}`}
              >
                <span className="interest__name">{INTEREST_LABELS[tag]}</span>
                <span className="interest__state mono">
                  {INTEREST_LEVEL_LABELS[prefs.interests[tag]]}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}

      <p className="muted">
        {counts.mustDo} must-do, {counts.avoided} ruled out. Ruled-out categories are never fetched,
        never scheduled.
      </p>
    </Question>
  );
}

function FoodStep({
  prefs,
  setPrefs,
  dietary,
  setDietary,
}: StepProps & { dietary: string; setDietary: (s: string) => void }) {
  const levels: { value: 0 | 1 | 2 | 3; label: string; note: string }[] = [
    { value: 0, label: "Fuel", note: "Feed me, don't plan around it" },
    { value: 1, label: "Some good meals", note: "A decent lunch and dinner" },
    { value: 2, label: "A real part of it", note: "Named places, worth a detour" },
    { value: 3, label: "The reason we came", note: "The trip is built around eating" },
  ];
  return (
    <Question title="How much is this trip about eating?">
      <div className="choices">
        {levels.map((l) => (
          <button
            key={l.value}
            className="choice"
            aria-pressed={prefs.foodImportance === l.value}
            onClick={() => setPrefs({ foodImportance: l.value })}
          >
            <span className="choice__label">{l.label}</span>
            <span className="choice__note">{l.note}</span>
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="dietary">Anything you can't eat?</label>
        <input
          id="dietary"
          className="input"
          value={dietary}
          placeholder="Coeliac, no shellfish, one of us is vegetarian"
          onChange={(e) => setDietary(e.target.value)}
        />
      </div>
    </Question>
  );
}

function GettingAroundStep({ prefs, setPrefs }: StepProps) {
  return (
    <Question title="How do you want to get around?">
      <div className="stack--tight">
        <p className="field-label">Walking</p>
        <div className="choices">
          <Choice
            value="lots-of-walking-fine"
            current={prefs.mobility}
            label="Walk all day"
            note="Up to about 12 km"
            onPick={(mobility) => setPrefs({ mobility })}
          />
          <Choice
            value="moderate"
            current={prefs.mobility}
            label="A fair amount"
            note="Around 7 km"
            onPick={(mobility) => setPrefs({ mobility })}
          />
          <Choice
            value="minimal-walking"
            current={prefs.mobility}
            label="As little as possible"
            note="Under 2.5 km, short hops"
            onPick={(mobility) => setPrefs({ mobility })}
          />
        </div>
      </div>
      <div className="stack--tight">
        <p className="field-label">Between stops, mostly</p>
        <div className="choices">
          <Choice
            value="walk"
            current={prefs.transport}
            label="On foot"
            onPick={(transport) => setPrefs({ transport })}
          />
          <Choice
            value="transit"
            current={prefs.transport}
            label="Public transport"
            note="Times are estimates"
            onPick={(transport) => setPrefs({ transport })}
          />
          <Choice
            value="taxi"
            current={prefs.transport}
            label="Taxis"
            onPick={(transport) => setPrefs({ transport })}
          />
          <Choice
            value="car"
            current={prefs.transport}
            label="Driving"
            onPick={(transport) => setPrefs({ transport })}
          />
        </div>
      </div>
    </Question>
  );
}

function BudgetStep({ prefs, setPrefs }: StepProps) {
  return (
    <Question title="What's the budget like?" hint="This shifts which places get chosen, not where you sleep.">
      <div className="choices">
        <Choice
          value="shoestring"
          current={prefs.budget}
          label="Shoestring"
          note="Free and cheap first"
          onPick={(budget) => setPrefs({ budget })}
        />
        <Choice
          value="moderate"
          current={prefs.budget}
          label="Moderate"
          onPick={(budget) => setPrefs({ budget })}
        />
        <Choice
          value="comfortable"
          current={prefs.budget}
          label="Comfortable"
          onPick={(budget) => setPrefs({ budget })}
        />
        <Choice
          value="no-limit"
          current={prefs.budget}
          label="Not a concern"
          onPick={(budget) => setPrefs({ budget })}
        />
      </div>
    </Question>
  );
}

function CompanyStep({ prefs, setPrefs }: StepProps) {
  return (
    <Question title="Who's coming?">
      <div className="choices">
        <Choice
          value="solo"
          current={prefs.travellingWith}
          label="Just me"
          onPick={(travellingWith) => setPrefs({ travellingWith })}
        />
        <Choice
          value="partner"
          current={prefs.travellingWith}
          label="With a partner"
          onPick={(travellingWith) => setPrefs({ travellingWith })}
        />
        <Choice
          value="friends"
          current={prefs.travellingWith}
          label="Friends"
          onPick={(travellingWith) => setPrefs({ travellingWith })}
        />
        <Choice
          value="kids"
          current={prefs.travellingWith}
          label="With kids"
          note="Shorter stops, more open air"
          onPick={(travellingWith) => setPrefs({ travellingWith })}
        />
        <Choice
          value="family-mixed"
          current={prefs.travellingWith}
          label="Mixed family"
          note="A range of ages and paces"
          onPick={(travellingWith) => setPrefs({ travellingWith })}
        />
      </div>
    </Question>
  );
}

function CrowdsStep({ prefs, setPrefs }: StepProps) {
  return (
    <Question title="The famous thing, or the quiet one?">
      <div className="choices">
        <button
          className="choice"
          aria-pressed={!prefs.avoidCrowds}
          onClick={() => setPrefs({ avoidCrowds: false })}
        >
          <span className="choice__label">Happy to queue</span>
          <span className="choice__note">The landmarks are landmarks for a reason</span>
        </button>
        <button
          className="choice"
          aria-pressed={prefs.avoidCrowds}
          onClick={() => setPrefs({ avoidCrowds: true })}
        >
          <span className="choice__label">Rather avoid the crush</span>
          <span className="choice__note">Lean toward the quieter equivalent</span>
        </button>
      </div>
    </Question>
  );
}

function ExtraStep({ extra, setExtra }: { extra: string; setExtra: (s: string) => void }) {
  return (
    <Question
      title="Anything else?"
      hint="Whatever the questions above missed. One really nice dinner, someone who can't manage stairs, a place you already booked."
    >
      <div className="field">
        <label htmlFor="freetext">In your own words</label>
        <textarea
          id="freetext"
          className="textarea"
          value={extra}
          placeholder="We'd like one proper dinner out. My mother can't manage stairs. We've already got tickets for the Serralves on Friday."
          onChange={(e) => setExtra(e.target.value)}
        />
      </div>
      <p className="muted">
        Wayfind reads this to adjust what it looks for. It only ever picks from places it actually
        found — it never invents one.
      </p>
    </Question>
  );
}
