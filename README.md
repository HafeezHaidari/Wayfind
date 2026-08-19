# Wayfind

A session-only itinerary planner. You name some cities, answer a short preference
interview, and it builds a day-by-day plan that is geographically coherent, open when you
arrive, matched to what you said you wanted, realistically paced, and able to explain why
each choice was made.

It is a proposal, not a verdict. Every stop shows its reasoning, every day shows what it
left out and why, and anything you disagree with you can pin, remove or swap.

---

## Missing inputs

Everything below was absent when this was built. Nothing here blocks the app: it is
complete and correct, and each item only unlocks the capability named next to it.

| Missing | What it would change | What happens without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | The three LLM jobs of §6b: reading the free-text interview box, semantic matching ("somewhere atmospheric for a last dinner"), and writing the per-stop rationale. | The free-text box is read by a deterministic keyword parser instead — cruder, and it says so in the itinerary notes. Semantic matching is skipped and the scorer's own order stands. Rationales fall back to a deterministic line naming which of your interests the place matched. **This path has never run against a live model.** The id-validation, the JSON schemas and every fallback are exercised by the test suite, but the three call sites are unproven end to end. |
| A live test city | Which cities are known to work against live data. | Six have been validated against live services: **Porto** and **Lisbon** (also recorded into `fixtures/`), **Ghent**, and **Tokyo, Kyoto and Osaka** (a nine-day three-city trip, which is what shook out the rate-limiting, non-Latin-name and dense-city problems described under [Known limitations](#known-limitations)). Any other city will be queried live and should work, but has not been checked. |
| `GOOGLE_PLACES_API_KEY` | Ratings and popularity as a quality signal. | Deliberately unused — see [Why not Google Places](#why-not-google-places). |

---

## Running it

Needs Node 20 or newer. Built and tested on Node 22.14.

```bash
npm install
npm run dev          # client on :5173, pipeline server on :8787
```

No keys are required. Copy `.env.example` to `.env` if you want to change anything.

### Offline, with no keys and no network

```bash
FIXTURE_MODE=true npm run dev     # plans Porto or Lisbon from recorded responses
FIXTURE_MODE=true npm test        # the whole suite, no network, no keys
```

`FIXTURE_MODE` swaps only the transport. Every parsing, matching, ranking and scheduling
step runs the same code it runs against live data — these are recordings replayed through
the real pipeline, not canned outputs.

To record another city:

```bash
npm run record-fixtures -- "Seville"
```

### Verifying the parts a test runner cannot see

Three acceptance criteria are facts about rendered layout, not about data. They are checked
in a real headless browser, against a running dev server:

```bash
npm run dev            # in one terminal
npm run preview        # screenshots + measures the rail's px-per-minute
npm run verify:export  # exports, reloads it with the network cut, then prints it
```

`verify:export` opens the exported page in a context where every outbound request is
aborted and asserts what actually rendered — fonts, route drawing, warnings, layout — then
prints it to PDF and counts the pages.

---

## How it decides

### Where the places come from

Free sources only, layered, each doing the thing it is good at.

| Source | What it contributes | Where |
|---|---|---|
| **OpenStreetMap** (Overpass) | Coverage, coordinates, categories, and — the reason it is load-bearing — `opening_hours`. Weak on quality: it returns every one of a city's four hundred cafés with no hint which are good. | `src/server/pipeline/overpass.ts` |
| **Wikivoyage** | Editorial judgment. A knowledgeable human decided these places were worth listing, and roughly in what order. This is the quality signal OSM lacks. | `src/server/pipeline/wikivoyage.ts` |
| **Wikidata** | Notability, as sitelink count across language editions, log-scaled. | `src/server/pipeline/wikidata.ts` |
| **OSRM** | Road-network distances between candidates. | `src/server/pipeline/osrm.ts` |
| **Nominatim** | Geocoding a typed city name, and its country code (which the opening-hours parser needs for public-holiday rules). | `src/server/pipeline/geocode.ts` |

A Wikivoyage listing matched to an OSM object is the strongest kind of candidate: editorial
endorsement *and* structured hours. Matching is by shared Wikidata id where there is one,
otherwise name similarity plus proximity (`src/server/pipeline/match.ts`).

Large cities need one extra step. English Wikivoyage splits them across district
sub-articles — Tokyo's own page holds 97 listings and every one is an embassy, while its
39 `Tokyo/…` district pages hold the museums and temples. When a parent article comes back
thin, Wayfind follows up to eight of its district links, in the order the editors listed
them, which is the order that puts the central districts first.

One Overpass query per city per generation, with all categories batched into it and a
per-category result limit. Refinements never re-source: they reschedule against a
process-lifetime cache holding third-party POI records only (`src/server/pipeline/cache.ts`).

Outbound calls are gated on the server (`src/server/pipeline/limiter.ts`): one Overpass
query at a time — half the two-per-IP allowance the public instance publishes — and Wayfind
reads `/api/status` to see whether a slot is free before asking for one.

### How they are scored

A weighted sum in ordinary code — no AI anywhere in the ranking. **The weights live in
`src/shared/scoring-config.ts`** and that is the file to tune.

| Term | Weight | What it measures |
|---|---:|---|
| Interest match | 10 | Whether the POI's categories intersect what you said you wanted, scaled by how strongly. The dominant term by design. |
| Editorial endorsement | 5 + 2.5 + 1.5 | Listed in Wikivoyage at all, how near the top of its section, and how much was written about it. |
| Notability | 3 | Wikidata sitelinks, log-scaled. |
| Price fit | 2 | Price tier against your budget. |
| Group fit | 2.5 | Kid-friendliness and tagged accessibility against who's coming and how far you'll walk. |
| Crowd handling | ±4 | With "rather avoid the crush", penalises the most notable and lifts the quieter equivalent. |

Duration defaults (a major museum is 120 minutes, a viewpoint 30) live in
`src/shared/categories.ts`; everything the scheduler tunes on — pace targets, day start and
end, walking caps, meal windows, buffers — lives in `src/shared/planning-config.ts`.

None of this claims an optimum. There isn't one: the objective function is your own
preferences, and those are partly unstated and mutually contradictory. What it produces is
an ordering it can defend and you can override.

### Where the AI is, and is not

Three jobs only, all optional:

1. Reading the free-text box into structured preference adjustments.
2. Picking from an already-retrieved shortlist when category tags are too coarse.
3. Writing the one-line rationale per stop (batched one call per day; off by default behind
   `ENABLE_RATIONALE`, because it is cosmetic spend).

**The model never produces a place name.** Every call that touches places receives the
candidates as input and must return ids; returned ids are checked against the input set and
anything unrecognised is discarded and logged as a bug. That is enforced structurally, in
`validateIds` in `src/server/pipeline/llm.ts`, not by asking the prompt nicely.

Everything else — sourcing, matching, scoring, clustering, sequencing, the timeline, the
opening-hours logic — is deterministic code.

---

## Known limitations

**Transit times are estimates.** A real transit router needs a GTFS feed per city and is a
project in itself. When you pick public transport, Wayfind applies a calibrated multiplier
over walking time with a floor for waiting and interchange, and labels every such estimate
with a `≈` in the interface. Being honest about an estimate beats a fake-precise wrong
number.

**Walking times are derived, not routed.** The public OSRM demo server answers every profile
in the URL with the same numbers, and those numbers are car speeds — `/table/v1/foot/...`
returns about 32 km/h through central Porto. So Wayfind uses OSRM for what it genuinely
provides, real road-network *distances*, and derives walking time from those at a stated
pace. Driving mode uses OSRM's durations directly, which is what they actually are.
Self-hosting an OSRM foot profile and pointing `OSRM_URL` at it would fix this properly.

**Opening hours are often unknown.** OSM carries `opening_hours` for a minority of places —
in the recorded Porto set, about a third of the top candidates. A place with unknown hours
is still schedulable, but the stop is marked with a caution rule on the rail, labelled
"hours unconfirmed", and named in the day's warning block. A place with *known* hours is
never scheduled outside them; that is a hard constraint, not a penalty.

There is one deliberate exception: a stop **you** pin to a specific time stays at that time
even if the place looks closed then, and the day says so. The scheduler never chooses a
closed slot; you may, knowingly.

**Public-holiday rules are approximated when the country is unknown.** `PH` clauses are
common and can only be evaluated against a country's holiday table. Wayfind takes the
country from the geocoder; if a city was entered by coordinates instead, the holiday clauses
are dropped and the resulting hours are flagged unverified.

**Wikivoyage coverage varies.** Porto's article yields 61 listings, about 20 of which match
an OSM object. A thinner article means the ranking leans harder on OpenStreetMap, which is
worse at knowing what is worth seeing — the itinerary says so in its notes when that
happens. Cities with no Wikivoyage article at all are ranked on OSM alone, and it says that
too. For big cities the district-article step above usually recovers the signal, but it
reads eight districts at most, so an outlying neighbourhood can still be missed.

**The map-data service does go down.** During development `overpass-api.de` spent about an
hour returning `504 — the server is probably too busy` for *every* query, including a
200-metre single-selector probe, while reporting free slots. That is the backend, not the
rate limiter, and no amount of politeness on the client side fixes it. Wayfind falls back
across free, keyless Overpass mirrors (`OVERPASS_FALLBACK_URLS`) and rests an unresponsive
host for five minutes. Mirrors can lag the main database by weeks, so a fallback may serve
slightly stale opening hours. If everything is down you get a message saying so rather than
a broken itinerary.

**Dense cities are slower.** A three-city Japanese trip takes around three minutes from
cold, against about sixteen seconds for a single European city. Most of that is Overpass
scanning a dense area and the extra district-article reads. Refinements afterwards are
fast, because they never re-source.

**Opening-hours coverage is worse in some countries than others.** Porto's top candidates
carry `opening_hours` about a third of the time; Tokyo's far less. Wayfind schedules
unknown-hours places anyway and marks every one of them, so a Japanese itinerary carries
noticeably more "hours unconfirmed" labels than a Portuguese one. That is the data, not a
judgement about the place.

**Cross-language name matching is imperfect.** Wikivoyage's "City Hall" and OSM's "Câmara
Municipal do Porto" only match if one of them carries a Wikidata id. Unmatched listings
still become candidates — they just arrive without structured opening hours.

**Names outside the Latin alphabet.** Where OpenStreetMap has a `name:en` tag, that is what
the itinerary shows, with the local-script name beside it — the English half is what you
read, the local half is what you point at. Roughly 60% of Tokyo's candidates have both. A
place with no `name:en` appears in its own script only.

**No live occupancy, prices, or bookings.** Nothing here checks whether a museum is sold
out, what a ticket costs today, or whether a restaurant has a table. That is out of scope.

---

## Why not Google Places

It would give the best quality signal — ratings, popularity, current opening state — and it
is the one paid option in the stack, so it is not used.

The cost is worse than it looks. Google retired the flat $200 monthly credit in March 2025
in favour of per-SKU free thresholds, and asking for a `rating` field moves the call from
Place Details Essentials into a higher-priced tier. A single generation ranks several
hundred candidates per city; at current per-SKU rates a few trips a month would clear the
free thresholds, and the bill scales with every refinement that re-ranks.

The seam is there if you want it: `src/server/pipeline/providers.ts` defines a
`QualitySignalProvider` interface with the Google implementation stubbed out and refusing to
run. Swapping it in is a one-file change behind `GOOGLE_PLACES_API_KEY`. A provider may
enrich candidates; it may never introduce them, which is the same rule the LLM lives under.

---

## What this deliberately does not do

No accounts, no login, no server-side database, no saved trips. The server is a stateless
pipeline: brief in, itinerary out. Closing the tab loses the trip unless you exported it —
which is why the export screen is one click from the itinerary.

Also out of scope: booking or ticketing, live transit routing, flights and inter-city
transport (Wayfind plans *within* cities), social features, native apps.

---

## Acceptance criteria

Every criterion in the brief's §11b is met. The layout ones were verified by measuring a
real browser, not by reading the CSS:

| Criterion | How it is checked |
|---|---|
| Two cities and a completed interview produce a full itinerary | `tests/pipeline-fixture.test.ts` |
| No scheduled stop falls outside its POI's known hours | `tests/scheduler-hours.test.ts` (16 cases) + the fixture pipeline |
| A POI closed on a weekday never appears on that weekday | `tests/scheduler-hours.test.ts` |
| Every stop traces back to a real retrieved POI id | `tests/scheduler.test.ts`, `tests/pipeline-fixture.test.ts` |
| Pinning a stop to a time puts it at that time | `tests/scheduler.test.ts`, `tests/pipeline-fixture.test.ts` |
| Skipping the interview still produces a reasonable itinerary | `tests/pipeline-fixture.test.ts` |
| Days respect the pace setting within one stop | `tests/scheduler.test.ts` |
| Daily walking respects the mobility setting | `tests/scheduler.test.ts` |
| `FIXTURE_MODE=true npm test` passes with no keys and no network | Run with every endpoint pointed at a dead port: 111 passing |
| Rail block heights are proportional to duration | `npm run preview` — measured at 3.40 px/min on every block; 120 min renders 4.00× the height of 30 min |
| The exported page renders with the network disabled | `npm run verify:export` — 0 outbound requests attempted, fonts loaded, route drawn, no overflow |
| Printing produces one readable day per page | `npm run verify:export` — chrome hidden, times at 20px, 8 pages for a 3-day trip |
| Unknown-hours stops are visibly marked and named | `tests/pipeline-fixture.test.ts` |

---

## Attribution

Place data from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors under
ODbL, [Wikivoyage](https://en.wikivoyage.org) under CC BY-SA, and
[Wikidata](https://www.wikidata.org) under CC0. Routing by the
[OSRM](https://project-osrm.org) demo server, geocoding by
[Nominatim](https://nominatim.openstreetmap.org). Type is IBM Plex Mono, Archivo and Public
Sans, all under the SIL Open Font License.

These are free, shared, volunteer-supported services. Wayfind makes one Overpass query and
one OSRM call per city per generation, and caches both. Please keep it that way.
