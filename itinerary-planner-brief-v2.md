# Build Brief: "Wayfind" — Preference-Driven Itinerary Planner

Build a session-only web app that generates a coherent, constraint-respecting day-by-day travel itinerary from a user's chosen cities and their answers to a short preference interview. The app has internet access and may call third-party APIs.

## 0. Operating Assumptions, Preflight, and Build Order

### 0a. Session continuity (read this before anything else)

Work on this project spans multiple sessions with no shared memory between them. `DOCUMENTATION.md` in the project root is the only thing carrying state across that gap. Treat it as load-bearing.

**First action of every session:**

1. Read `DOCUMENTATION.md`. Its Current State block describes where the build was left.
2. Verify that block against the actual repository. A session can die mid-edit, so the file may claim a stage is complete when it is not. Check `git log`, run the test suite, confirm the claimed stage actually works. **Where the state file and the repository disagree, the repository is correct.** Correct the state file, note the discrepancy in the decision log, and continue from what is actually true.
3. Resume at the Next Action listed there. Do not restart from stage 1, and do not redo completed stages to "make sure".

If `DOCUMENTATION.md` does not exist or has no Current State block, this is session one: create it from the template in §14a and begin at §0c.

**Updating it:** rewrite the Current State block whenever a stage completes, a blocker appears, or the next action changes. Do not wait for the end of a session, sessions frequently end abruptly. Append to the Decision Log when a non-obvious choice is made or a dead end is hit. Commit to git at each completed stage of §0d.

### 0b. Standing decisions (already made, do not re-litigate)

- **Budget: free tiers only.** Do not incur paid API spend. Where a provider offers a free tier, stay inside it. If a step genuinely cannot be done without spend, stop and report it under §12 rather than spending.
- **Scale: single-user, personal use.** Do not design for multi-tenancy, horizontal scaling, or production traffic. Correctness and cost discipline matter, throughput does not.
- **"Optimal" is not the goal, and do not build as though it were.** There is no objective optimum for a trip, because the objective function is the user's own preferences and those are partially unstated and mutually contradictory. What this app produces is an itinerary that is *defensibly good*: geographically coherent, open when the user arrives, matched to stated preferences, realistically paced, and able to explain why each choice was made. Do not build a scoring system that claims optimality, and do not present output to the user as optimal. Present it as a proposal with visible reasoning the user can override.
- **Scope of AI use is fixed by §6. Do not expand it.** Most of this app is deterministic algorithm, not AI. Read §6 before assuming an LLM should make a given decision.

### 0c. Preflight, and what to do about missing inputs

Before writing application code, check the environment and record the results:

1. **Runtime**: confirm Node 20+ and a package manager. If absent, report and stop.
2. **Credentials**: enumerate which of the keys in `.env.example` are actually set. Do not assume any are.
3. **Data source reachability**: confirm the Overpass API and the chosen routing engine respond. Both are free public services with rate limits and occasional downtime, see §5.

Inputs that cannot be derived from this document must never halt the build:

- **API keys.** If none are set, build everything and verify via `FIXTURE_MODE=true` (§11a). The app should be complete and correct, needing only keys to run live. Never invent a key, never hardcode one, never route around a missing key by stubbing the call.
- **A live test city.** If not supplied, use the fixture city in `fixtures/` for all development. State in the README which cities have been validated against live data and which have not.

Report every gap in the Missing Inputs section of the README (§14).

### 0d. Build order

Each stage working before starting the next. Commit at each boundary.

1. **Preference interview UI + preference model** (§3, §4). Pure client-side, no data sources, no scheduling. Produces a `TripBrief` object.
2. **Itinerary scheduler** (§7) as a pure function over synthetic POIs and synthetic travel times. This is the algorithmic core and it is fully testable offline with no API access. Do not build it after the data layer, build it before, so that data problems and scheduling problems never get debugged simultaneously.
3. **POI sourcing** (§5) against one city, with fixtures recorded.
4. **Travel time matrix** (§5d).
5. **Candidate ranking** (§6), including the LLM layer if keys are available.
6. **Map and itinerary UI** (§9). Build the time rail (§9a) before the map — the rail is the product, the map is support.
7. **Refinement loop** (§8) — user edits, app reschedules.
8. **Export.**

## 1. Hard Constraints

- **No user signup/login/auth of any kind.**
- **No server-side persistence.** No database, no user records, no analytics tied to individuals. Nothing written to disk beyond ephemeral temp files and the request-scoped caches permitted in §5e.
- **No cross-session state.** A closed tab means the trip is gone unless the user exported it.
- **Client holds the trip.** The server is a stateless pipeline: brief in, itinerary out.
- **The LLM never invents a place.** See §6b. This is the single most important correctness rule in this document.

## 2. Core User Flow

1. User names a trip and adds one or more cities, each with a date range or a number of days.
2. App runs a short preference interview (§4). Under a dozen questions, mostly single-tap, with a free-text box at the end for anything the structured questions missed.
3. App sources candidate places for each city (§5), ranks them against the brief (§6), and schedules them into days (§7).
4. App presents the itinerary: day tabs, ordered stops, map with the day's route, and a one-line rationale per stop explaining why it was chosen and why it sits at that time.
5. User refines (§8): remove a stop, pin a stop to a specific day or time, ask for more of one category or less of another, adjust pace. App reschedules around every pinned constraint.
6. User exports as JSON or a static shareable page, generated client-side.

## 3. Data Model

Define once, share client and server.

```typescript
type TripBrief = {
  id: string;
  name: string;
  cities: CityStay[];
  preferences: Preferences;
  freeText: string | null;        // unstructured extras from the interview
};

type CityStay = {
  cityName: string;
  lat: number; lng: number;       // city centroid, from geocoder
  startDate: string | null;       // ISO date; null if the user gave only a day count
  days: number;
  basecampLat: number | null;     // hotel/accommodation if the user supplied one
  basecampLng: number | null;
};

type Preferences = {
  pace: "relaxed" | "moderate" | "packed";        // target stops per day: 2-3 / 4-5 / 6-7
  dayStart: "early" | "midmorning" | "late";      // 07:00 / 09:30 / 11:00
  dayEnd: "early" | "moderate" | "late";          // 18:00 / 21:00 / late-night
  interests: Record<InterestTag, 0 | 1 | 2 | 3>;  // 0 = avoid entirely, 3 = prioritise
  budget: "shoestring" | "moderate" | "comfortable" | "no-limit";
  mobility: "lots-of-walking-fine" | "moderate" | "minimal-walking";
  transport: "walk" | "transit" | "taxi" | "car";
  foodImportance: 0 | 1 | 2 | 3;
  avoidCrowds: boolean;
  travellingWith: "solo" | "partner" | "friends" | "kids" | "family-mixed";
};

type InterestTag =
  | "museums" | "history" | "architecture" | "art"
  | "nature" | "parks" | "viewpoints" | "beaches"
  | "food" | "cafes" | "markets" | "nightlife"
  | "shopping" | "neighbourhoods" | "religious-sites"
  | "offbeat" | "photography" | "live-music";

type Poi = {
  id: string;
  name: string;
  lat: number; lng: number;
  tags: InterestTag[];
  sourceIds: { osm?: string; wikidata?: string; wikivoyage?: string };
  openingHours: OpeningHours | null;   // null = unknown, treat per §7c
  typicalDurationMin: number;          // from category defaults, see §5c
  priceTier: 0 | 1 | 2 | 3 | null;
  score: number;                       // ranking output, §6
  rationale: string | null;            // why it was chosen, §6c
  provenance: "osm" | "wikivoyage" | "wikidata" | "user-added";
};

type ScheduledStop = {
  poiId: string;
  arriveMin: number;                   // minutes from midnight
  departMin: number;
  travelFromPrevMin: number;
  pinned: boolean;                     // user-locked, scheduler must respect
  rationale: string | null;
};

type ItineraryDay = {
  dayIndex: number;
  cityName: string;
  date: string | null;
  stops: ScheduledStop[];
  warnings: string[];                  // e.g. "opening hours unknown for X"
};
```

`TripBrief` and the resulting itinerary live entirely in client state. The server never stores either.

## 4. The Preference Interview

Structured questions, not a chat. A conversational interview feels smart and produces worse data: users under-specify, answers are ambiguous, and every turn costs an LLM call. Use tappable choices that map directly onto the `Preferences` fields in §3.

Ask in this order, one screen per group:

1. **Pace** — "How full do you want your days?" → relaxed / moderate / packed
2. **Rhythm** — "When do your days start and end?" → two selects
3. **Interests** — a grid of the `InterestTag` values, each tappable through four states (avoid / neutral / interested / must-do). This is the highest-signal question in the interview; give it the most screen space.
4. **Food** — how much the trip is about eating, plus any dietary constraints as free text
5. **Getting around** — walking tolerance and preferred transport
6. **Budget**
7. **Who's coming** — solo / partner / friends / kids / mixed family
8. **Crowds** — willing to queue for the famous thing, or prefer the quieter alternative
9. **Anything else** — one free-text box. This is where "we want one really nice dinner" and "my mother can't manage stairs" arrive. Feed it to the LLM layer per §6.

Provide sensible defaults for every field so a user can skip the interview entirely and still get an itinerary. Never block generation on an unanswered question.

## 5. POI Sourcing

This is where a planner is won or lost. The scheduling algorithm is straightforward; knowing which places are worth visiting is not. Use a layered approach, free sources first.

### 5a. What each source is good for

- **OpenStreetMap via Overpass API** — free, no key, global coverage, structured tags, and crucially it carries `opening_hours` tags. Weak on quality signal: it will happily return every one of a city's four hundred cafes with no indication which are good. Use it for coverage, coordinates, categories, and hours.
- **Wikivoyage** — free, CC-licensed, human-written city guides with actual editorial judgment about what is worth seeing. This is the quality signal OSM lacks. Parse its "See", "Do", "Eat", "Drink" sections to identify which POIs a knowledgeable human thought were worth listing. Match entries back to OSM/Wikidata by name and proximity.
- **Wikidata** — free, structured, good for landmark significance (sitelink count across language editions is a reasonable proxy for how notable a place is).
- **Google Places** — best quality signal (ratings, popularity) but the costly option, and the cost is worse than it looks: Google retired the flat $200 monthly credit in March 2025 in favour of per-SKU free thresholds, and requesting a `rating` field pushes the whole call into a higher-priced tier. Do not use Google Places in the default configuration. Leave a provider interface so it can be swapped in behind a key, and note in the README what it would cost.

Default stack: **OSM for coverage and hours, Wikivoyage for editorial signal, Wikidata for notability.** All three are free and keyless.

### 5b. Sourcing procedure per city

1. Fetch the Wikivoyage article for the city. Extract listed POIs with their names, categories, and any coordinates or addresses given.
2. Query Overpass for POIs within the city bounding box, filtered to categories that map to the user's non-zero `InterestTag` values. Do not fetch categories the user marked "avoid" — that is both wasted bandwidth and a smaller candidate set to rank.
3. Match Wikivoyage entries to OSM objects by name similarity plus proximity. A matched pair is a strong candidate: it has editorial endorsement *and* structured hours and coordinates.
4. Pull Wikidata sitelink counts for matched entities as a notability signal.
5. Deduplicate. The same museum will appear under slightly different names across sources.

### 5c. Duration defaults

Every POI needs a `typicalDurationMin` or the scheduler cannot function. Derive from category, with a lookup table: major museum 120, small museum 60, viewpoint 30, park 45, café 45, sit-down restaurant 90, market 60, church 30, neighbourhood wander 90. Refine from Wikivoyage text where it says something useful. These defaults are load-bearing; put them in one file, not scattered through the scheduler.

### 5d. Travel times

Use **OSRM** (free public demo server for development, self-hostable if it rate-limits) for walking and driving matrices between candidate POIs. For transit, do not attempt a real transit router: it needs GTFS feeds per city and is a project in itself. Instead, when the user picks transit, apply a calibrated multiplier over walking-distance-with-a-floor, and label the estimate as approximate in the UI. Being honest about an estimate is better than a fake-precise wrong number.

Compute the matrix once per city per generation, not per scheduling iteration.

### 5e. Caching, and how it coexists with the no-storage rule

§1 forbids persisting user data. POI data is not user data, and re-querying Overpass for the same city on every refinement is both slow and rude to a free public service. Permitted: an in-memory, process-lifetime cache keyed by city and category, holding only third-party POI records, never a `TripBrief` and never anything identifying a user. It dies with the process. Do not write it to disk, and do not key it by anything user-specific.

## 6. Ranking, and Exactly Where AI Belongs

Most of this app does not need an LLM. Be deliberate about the boundary.

### 6a. Deterministic scoring (no AI)

Score every candidate POI with a weighted sum, computed in ordinary code:

- **Interest match**: does the POI's category intersect the user's tagged interests, weighted by the 0-3 level. Dominant term.
- **Editorial endorsement**: listed in Wikivoyage, and how prominently.
- **Notability**: Wikidata sitelink count, log-scaled.
- **Price fit**: POI price tier against the budget preference.
- **Crowd penalty**: if `avoidCrowds`, penalise the highest-notability items and boost mid-notability ones in the same category.
- **Group fit**: kid-friendliness, accessibility where tagged, against `travellingWith` and `mobility`.

Keep the weights in one config object with named constants, not magic numbers inline. They will need tuning, and tuning is impossible when they are scattered.

### 6b. The LLM layer, and its hard limit

The LLM does exactly three jobs:

1. **Interpret the free-text box** from the interview into structured adjustments: category weight changes, hard constraints ("no stairs"), or special requests ("one nice dinner"). Output is a diff against the `Preferences` object, applied deterministically.
2. **Semantic matching** where category tags are too coarse: "somewhere atmospheric for a last dinner" cannot be expressed as an OSM tag. Given a shortlist of already-retrieved candidates, pick which best fits a free-text descriptor.
3. **Write the per-stop rationale** (§6c).

**The LLM must never produce a place name that did not come from the retrieved candidate set.** It ranks, filters, and explains; it does not generate. This is the failure mode that makes AI trip planners untrustworthy: they confidently recommend restaurants that closed years ago or never existed. Structurally prevent it: every LLM call that touches POIs receives candidates as input and must return `Poi.id` values, never names. Validate the returned ids against the input set and discard anything unrecognised. Treat a returned id that was not in the input as a bug to log, not a place to visit.

### 6c. Rationale generation

Each scheduled stop gets one short line explaining the choice: why this place, why this slot. This is worth an LLM call because it is genuinely a writing task, and it is what makes the itinerary feel reasoned rather than arbitrary. Batch it: one call per day, not one per stop. It is cosmetic, so the itinerary must render correctly with every `rationale` null if the call fails or no key is set.

## 7. The Scheduler

A pure function: `(rankedPois, cityStay, preferences, travelMatrix, pins) => ItineraryDay[]`. No network calls, no AI, fully unit-testable. Build it first (§0d stage 2).

### 7a. Algorithm

1. **Select** the top-scoring POIs, targeting `pace` × days stops, over-selecting by roughly 50% so the scheduler has room to drop things that do not fit.
2. **Cluster** geographically into `days` groups, k-means or similar on coordinates, so a day does not zigzag across the city. If a basecamp is given, bias clusters toward it.
3. **Assign clusters to days**, respecting any day-specific constraints (a POI closed Mondays cannot land on the Monday cluster).
4. **Sequence within a day**: nearest-neighbour from the day's first fixed point, then a 2-opt improvement pass. Stop counts are small enough that this is cheap and meaningfully better than nearest-neighbour alone.
5. **Lay out the timeline**: start at the preference-derived day start, walk the sequence adding `typicalDurationMin` and travel time from the matrix, insert meal breaks per §7b, stop at day end.
6. **Drop what does not fit**, lowest score first, and record what was dropped so the UI can offer it as an alternative.

### 7b. Meals

Insert a lunch break in a window around midday and a dinner break in the evening, durations scaled by `foodImportance`. If food is a high interest, place an actual ranked food POI in the slot; if low, reserve time without prescribing a venue. Do not schedule a museum across the entire lunch window and leave the user unfed at 16:00, which is what naive schedulers do.

### 7c. Opening hours, the thing that breaks naive planners

This is the most common way generated itineraries fail in reality: sending someone to a museum on the day it is closed.

- Parse OSM `opening_hours` syntax properly. It is a real grammar with a well-known specification and existing parser libraries. Do not attempt a regex.
- A POI whose hours are known and closed at the proposed time is **not schedulable there**. This is a hard constraint, not a scoring penalty.
- A POI with `openingHours: null` (unknown, which is common in OSM) is schedulable, but the day must carry a warning naming it, and the UI must surface that warning rather than burying it. Never silently present an unverified assumption as fact.
- Watch weekday closures specifically. Many major museums close one weekday. If a city stay includes that weekday, the scheduler must route around it rather than discovering the conflict at the end.

### 7d. Realism guards

- Enforce a minimum viable stop duration; do not produce a 12-minute museum visit to make the arithmetic work.
- Cap total daily walking distance against the `mobility` preference.
- Leave buffer time between stops rather than scheduling to the minute. A plan with zero slack is wrong the moment anything runs long.

## 8. Refinement Loop

The first generated itinerary is a draft. Refinement is the feature that makes the app useful rather than a novelty.

- **Remove a stop** → reschedule that day, optionally pulling in the best dropped candidate.
- **Pin a stop** to a day, or to a specific time → the scheduler treats it as a fixed point and builds around it. Pins are never moved or dropped, even when that produces a worse overall day.
- **"More of this / less of this"** → adjust the relevant category weight and regenerate.
- **Change pace or day length** → reschedule without re-sourcing POIs (the candidate set is unchanged, only the layout is).

Every refinement must be fast, which means it must not re-run POI sourcing. Sourcing happens once per city; refinement operates on the cached candidate set (§5e).

## 9. Presentation

The itinerary is the product. A correct plan rendered as generic gray cards is a worse product than a slightly weaker plan rendered so the day is legible at a glance. Treat this section as binding, not as decoration to be added later.

### 9a. The governing idea

An itinerary is a **timetable**, and its native visual language is wayfinding: departure boards, transit signage, printed schedules. Build from that vernacular, not from the dashboard-card idiom. The specific consequence: a day is a continuous vertical time axis, not a stack of equal-sized cards.

**Signature element — the proportional time rail.** A vertical axis runs down the left of each day. Every stop is a block whose *height is proportional to its actual duration*. Travel between stops is a literal gap in the rail, hairline-ruled, labelled with the minutes and mode. Meal breaks are blocks too.

This is the one place to spend effort, because it encodes something true that uniform cards actively hide: the shape of the day. A packed day looks dense and tight. A relaxed day has visible air in it. A day with a three-hour museum and four quick stops looks nothing like a day with seven even ones. The user can see whether the pace matches what they asked for without reading a single number, and can see at a glance where the slack is. Uniform-height cards lie about all of this.

Keep everything around the rail quiet. One memorable element, disciplined surroundings.

### 9b. Tokens

Define these once as CSS custom properties and derive every color and type decision from them. Do not introduce colors outside this set.

```
--paper:    #F1F3F2   /* cool off-white; explicitly not a warm cream */
--ink:      #10201F   /* deep near-black, green undertone */
--ink-soft: #45514E   /* secondary text */
--rail:     #9AA6A2   /* the time axis, hairlines, travel gaps */
--locked:   #0B6E4F   /* user-pinned stops: fixed, respected, confirmed */
--caution:  #B4531A   /* reserved exclusively for warnings (§9d). Never decorative. */
```

The two accents are semantic, not stylistic. Green means the user locked it and the scheduler must respect it. Orange means something is unverified. If either color appears anywhere it does not carry that meaning, remove it.

Type, three roles:
- **Time spine**: a monospace with true tabular figures (IBM Plex Mono or equivalent). Times are data and must align vertically down the rail. This is non-negotiable — proportional figures in a time column look broken.
- **Place names**: a variable grotesque with width axes (Archivo or equivalent), set with weight and a slight expansion. This is where the personality sits.
- **Body and labels**: a neutral humanist sans (Public Sans or equivalent).

Do not pair a high-contrast serif display face with a warm cream background. That combination is the current default look for generated interfaces and it will read as templated regardless of how well the rest is executed. If any of the named faces are unavailable, substitute within the same category and record the substitution in the decision log.

### 9c. Layout

**Desktop**: two columns. The rail and its stops occupy the left, roughly 60%, and are the primary artifact. The map is sticky on the right, syncing with the rail — hovering a stop highlights its pin, clicking a pin scrolls the rail to that stop. Day tabs sit above both.

**Mobile**: the rail goes full width. The map becomes a collapsed strip that expands to a sheet on tap. Never let the map eat the itinerary on a small screen — on a phone in a foreign city, the list is what gets read.

A stop block contains, in descending prominence: arrival time (on the spine), place name, duration, one-line rationale, and category. The rationale is what makes the plan feel reasoned rather than arbitrary — give it real space, not caption treatment.

### 9d. Warnings, honestly placed

§7c produces warnings for POIs with unknown opening hours. These must be visible without being alarming. Mark the affected stop with a `--caution` hairline on its rail edge and a short plain label ("hours unconfirmed"), and collect the day's warnings in a small block at the foot of the day. Do not use a modal, a red banner, or an icon with no text. The user needs to know which stop to double-check, not to feel that something is broken.

### 9e. Alternatives

What the scheduler dropped (§7a step 6) lives in a panel below the day, not hidden behind a menu. Each entry shows the place, its score relative to what was scheduled, and why it did not fit ("no time after the museum", "closed Tuesday"). One tap swaps it in and reschedules. This panel is doing real work: it is how the user learns the plan is a proposal rather than a verdict.

### 9f. Print and offline

An itinerary gets printed, or opened on a phone with no signal in a country with expensive roaming. Both are primary uses, not afterthoughts.

Ship a print stylesheet: one day per page, times set large, map replaced by a static image or omitted, interactive chrome removed, rationale kept, warnings kept. The exported static page (§14) must render fully without network access — no CDN fonts, no live map tiles, everything inlined. Test this by loading the export with the network disabled.

### 9g. Copy

Write labels from the traveller's side of the screen. "Closed Tuesdays" not "opening_hours constraint violated". "Hours unconfirmed" not "null openingHours". Actions keep the same name throughout: a button that says "Pin this stop" produces a stop labelled "Pinned".

Empty and failure states are directions, not moods. An empty city is an invitation ("Add a city to start planning"). A failed generation says what went wrong and what to do ("No places found for these interests in Porto — try widening your interests"). Errors do not apologise and are never vague.

### 9h. Quality floor

Responsive to mobile. Visible keyboard focus on every interactive element. `prefers-reduced-motion` respected. Sufficient contrast on all text including the `--ink-soft` and `--rail` values, verified rather than assumed. Motion, if any, belongs to the rail-to-map sync and nothing else — scattered animation is the fastest way to make a considered interface look generated.

### 9i. Screens

- **Trip setup**: name, add cities with dates or day counts, optional accommodation address per city.
- **Interview**: the §4 question flow, skippable at any point, progress visible.
- **Itinerary**: day tabs, the time rail, synced map, day warnings, alternatives panel.
- **Export**: JSON or the offline-capable static page.

## 10. Concurrency, Rate Limits, and Cost Control

- **Overpass is a free shared service.** Respect it: one query per city per generation, batch categories into a single query rather than one per category, set a sane timeout, and back off on 429. Do not hammer it during development — that is what fixtures are for.
- **OSRM's public demo server** is likewise shared and rate-limited. Cache the matrix per city per generation.
- **LLM calls**: three call sites total (free-text interpretation, semantic matching, rationale). Rationale is batched per day. Use the cheapest small model that produces acceptable output; none of these three tasks needs a frontier model.
- **Rationale generation off by default** behind `ENABLE_RATIONALE`, since it is cosmetic spend.
- **Instrument**: log per generation how many Overpass queries, OSRM calls, and LLM calls were made. Aggregate counters only, no payloads.
- **Logging**: gate verbose logging (POI payloads, LLM responses, prompts) behind `DEBUG_PIPELINE=true`, default off, development only. With the flag off, aggregate counters and error stages only.

## 11. Verification

### 11a. Fixtures and offline development

- `fixtures/` holds a recorded Overpass response, a recorded Wikivoyage article, a recorded travel matrix, and expected ranking output for one city.
- Every pipeline stage takes its input as an argument rather than fetching internally, so identical logic runs against fixtures or live data.
- `FIXTURE_MODE=true` runs end to end with no network and no keys.
- The scheduler (§7) needs no fixtures at all — it is a pure function and gets real unit tests over synthetic POIs.

### 11b. What counts as done

- A trip with two cities and a completed interview produces a full itinerary with no unhandled errors.
- No scheduled stop falls outside its POI's known opening hours. This is the single most important test in the suite; write it first and make it comprehensive.
- A POI closed on a specific weekday never appears on that weekday.
- Every stop in the output traces back to a real retrieved POI id. No stop exists that was not in the candidate set (§6b).
- Pinning a stop to a time produces an itinerary where that stop sits at that time.
- Skipping the entire interview still produces a reasonable itinerary from defaults.
- Days respect the pace setting within a tolerance of one stop.
- Total daily walking respects the mobility setting.
- `FIXTURE_MODE=true npm test` passes with no keys and no network.
- Stop block heights on the time rail are proportional to duration: a 120-minute stop renders visibly taller than a 30-minute one (§9a).
- The exported static page renders completely with the network disabled — no missing fonts, no blank map region, no broken layout (§9f).
- Printing produces one readable day per page with no interactive chrome (§9f).
- Every stop with unknown opening hours is visibly marked and named in the day's warning block (§9d).

### 11c. Prohibited ways of passing

- Do not stub or hardcode POI data to satisfy §11b. Fixtures replaying real recorded responses through real logic are fine; canned outputs bypassing the logic are not.
- Do not weaken the opening-hours constraint to a soft penalty because scheduling is easier that way. It is a hard constraint.
- Do not let the LLM generate place names to fill a thin candidate set. A short itinerary from a thin set is correct; a padded one is not.
- Do not swallow exceptions and return an empty success.
- Do not defer the presentation layer (§9) to "polish later" and ship uniform cards in the meantime. The proportional rail is a functional requirement, not styling.
- Do not silently narrow scope to reach a working state. Narrowing scope is a decision to report (§12), not one to make quietly.

## 12. Autonomy: Decide Alone vs. Stop and Report

Work autonomously. Assume no one is available mid-build: a blocker is something to route around and report, not wait on. The standing decisions in §0b are settled.

**Decide independently:**
- Library choices not named here (Overpass client, opening-hours parser, clustering, 2-opt implementation)
- File structure, component decomposition, naming
- Scoring weight values and duration defaults, tuned against fixtures
- Interview wording and question UI
- Layout, spacing, and component details within the §9b token set. The tokens and the time-rail concept (§9a) are fixed; how they are executed is not.
- Retry counts, timeouts, backoff
- Any bug fix or refactor needed to make a specified feature work

**Stop and report:**
- Wikivoyage coverage for a target city is too thin to provide editorial signal, leaving OSM-only ranking. Report the quality degradation; do not substitute a paid source.
- A required free service (Overpass, OSRM) is unavailable or rate-limits too aggressively for development. Report; do not switch to a paid provider.
- Meeting a requirement would need persistent server-side storage or user accounts (§1).
- An acceptance criterion in §11b cannot be met. Leave it failing and report it.
- Two sections of this brief contradict each other. Flag it rather than silently picking a reading.

## 13. Explicitly Out of Scope

- Accounts, login, saved trips across sessions
- Any server-side database
- Booking, reservations, ticket purchase, price checking
- Real-time transit routing with live GTFS
- Flights and inter-city transport logistics (the app plans *within* cities; inter-city travel is assumed handled by the user)
- Social features, sharing to a service, community itineraries
- Native mobile — web only

## 14. Deliverable

- Working local dev setup (`npm run dev`), plus a working `FIXTURE_MODE=true` path needing no keys and no network.
- `.env.example` listing every key, `DEBUG_PIPELINE`, `FIXTURE_MODE`, `ENABLE_RATIONALE`.
- `fixtures/` populated per §11a.
- `DOCUMENTATION.md` maintained per §14a.
- A print stylesheet and a verified offline-capable export (§9f).
- README with a **Missing Inputs** section at the top per §0c, plus: the sourcing strategy and what each source contributes, which cities have been validated against live data, the scoring weights and where to tune them, known limitations (transit estimates, unknown opening hours, Wikivoyage coverage gaps), and any unmet acceptance criterion with its reason.

### 14a. DOCUMENTATION.md structure

Two parts, different update rules. Do not merge them.

**Part 1 — Current State.** Overwritten in place every time. Never appended to. Contents: stage reached in §0d and which stages are verified working; what is in progress; the single next action; known broken, blocked, or unverified items; any active deviation from this brief.

**Part 2 — Decision Log.** Append-only, newest at the bottom. Non-obvious decisions and rejected alternatives; dead ends and what made them fail; deviations with justification; scoring-weight tuning outcomes.

Do not record routine actions — git carries those. Do not paste POI payloads or LLM responses into either part; describe the shape of the problem instead.

```markdown
# DOCUMENTATION

## Current State
<!-- OVERWRITE this whole section on every update. Do not append. -->

**Stage:** (§0d stage, e.g. "2 of 8 — scheduler")
**Verified working:** 
**In progress:** 
**Next action:** 
**Blocked / unverified:** 
**Active deviations from spec:** 
**Last updated:** (what triggered this update)

---

## Decision Log
<!-- APPEND ONLY. Newest at the bottom. Decisions and dead ends, not actions. -->

### <short title>
**Context:** what problem prompted this
**Decision:** what was chosen
**Rejected:** what else was considered and why it lost
```
