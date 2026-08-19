# DOCUMENTATION

## Current State
<!-- OVERWRITE this whole section on every update. Do not append. -->

**Stage:** 8 of 8 complete, plus a round of fixes from the first real multi-city, non-Latin-script,
live-data run (Tokyo + Kyoto + Osaka, 9 days).
**Verified working:** The whole flow, end to end, live and from fixtures. 111 tests pass
(`npx vitest run`), `npx tsc --noEmit` clean, `npm run build` succeeds. Browser checks still pass:
rail at exactly 3.40 px/min (120 min renders 4.00× a 30 min stop), the export renders with every
outbound request aborted — now checked in WebKit as well as Chromium — and print gives one day per
page. The exported page carries a real OpenStreetMap basemap per day, embedded as an image. The Japan trip that previously failed
outright now completes in about 3 minutes cold and produces the canonical landmarks for all three
cities — Nijō Castle, Heian Shrine and Kyoto Imperial Palace; Osaka Castle, Kaiyukan and Tsūtenkaku;
Tokyo Tower, Tsukiji Outer Market and Yasukuni Shrine — with no coverage-degradation warnings.
**In progress:** Nothing.
**Next action:** None outstanding. If work resumes: run the §6b LLM layer against a live key (still
the only part never exercised end to end), then look at opening-hours coverage in Japan, which is
low (3 of 33 scheduled Tokyo stops carry hours) because OSM tags them sparsely there.
**Blocked / unverified:** No `ANTHROPIC_API_KEY`, so the §6b LLM layer has never run against a live
model. Validated live: Porto, Lisbon (both also recorded as fixtures), Ghent, Tokyo, Kyoto, Osaka.
The public OSRM demo serves car speeds on every profile, so walking times are derived from its
routed distances. **`overpass-api.de` was fully unavailable for roughly an hour during this session**
— returning 504 "the server is probably too busy" for even a 200-metre single-selector query — which
is the §12 report: a required free service was unavailable, and no paid provider was substituted.
**Active deviations from spec:** Six, all logged: `/api/geocode` built during stage 1; `Poi` carries
`category` and `localName`; `CityStay` carries `countryCode` and `englishName`; a stop pinned to a
time may sit outside the POI's hours (§7c vs §8); long slack gaps are height-capped while stops and
meals stay exactly proportional.
**Last updated:** After replacing the exported schematic with a real embedded basemap.

---

## Decision Log
<!-- APPEND ONLY. Newest at the bottom. Decisions and dead ends, not actions. -->

### Inherited state file described a different project
**Context:** `DOCUMENTATION.md` existed at session start with a Current State block, but it said
"Not started" and its Next Action referred to a "TikTok collection URL" spike that appears nowhere in
this brief. The directory contained no code and no git repository.
**Decision:** Per §0a, the repository is authoritative where the two disagree. Treated this as
session one: reinitialised the state file from the §14a template and began at §0c preflight.
**Rejected:** Looking for the referenced TikTok spike — it belongs to a different brief and acting on
it would have built the wrong thing.

### Stack: Vite + React + TypeScript client, Express pipeline server, Vitest
**Context:** §1 requires a client that holds the trip and a stateless server that only transforms.
The server exists solely because Overpass, Wikivoyage, OSRM and any LLM call cannot be made from the
browser (CORS, and keys must not reach the client).
**Decision:** Vite + React 19 + TS for the client; Express 5 for a four-endpoint stateless server;
Vitest for tests, since the scheduler is a pure function and needs fast offline unit tests (§11a).
**Rejected:** Next.js — its value is server rendering and routing conventions this app has no use
for, and it invites exactly the server-side persistence §1 forbids. A browser-only app with no
server — blocked by CORS on Overpass/Wikivoyage and by §6b needing a server-held key.

### Self-hosted fonts rather than a font CDN
**Context:** §9b names IBM Plex Mono, Archivo and Public Sans. §9f requires the exported static page
to render fully with the network disabled — no CDN fonts.
**Decision:** `scripts/fetch-fonts.ts` downloads the latin and latin-ext woff2 subsets once into
`public/fonts/` (620 KB total) and emits two stylesheets: `fonts.css` with file URLs for the app, and
`inline.css` with the same faces base64-encoded, which the export fetches and embeds. All three
named families were available, so no substitution was needed.
**Rejected:** Linking `fonts.googleapis.com` — fails the offline export outright. Base64-inlining the
fonts into the app bundle as well — adds ~350 KB to every page load to solve a problem only the
export has.

### Category catalogue as the single source of durations, tags and Overpass selectors
**Context:** §5c says duration defaults are load-bearing and must live in one file rather than being
scattered through the scheduler.
**Decision:** `src/shared/categories.ts` holds one record per category carrying its Overpass
selectors, interest tags, typical and minimum duration, price tier and kid-fit. Adding a category is
a single-file change, and the scheduler reads durations from POIs that were built from it.
**Rejected:** A bare `Record<CategoryKey, number>` duration table — it would have left the OSM tag
mapping somewhere else, and the two drift apart the moment a category is added.

### Duration refinement: `tourism=museum` is not automatically a two-hour museum
**Context:** §5c gives 120 minutes for a major museum and 60 for a small one, but OSM tags both
`tourism=museum`. Scheduling every one-room local museum at two hours wastes whole days.
**Decision:** `categorise()` demotes a `tourism=museum` without a `wikidata` or `wikipedia` tag to
`small-museum` (60 min). A sitelinked institution is the cheapest available proxy for one big enough
to justify the longer default.
**Rejected:** Using OSM `building:area` or floor count — too rarely tagged to be usable.

### §7c and §8 contradict each other on a stop pinned to a closed time
**Context:** §7c makes opening hours a hard constraint — a POI known to be closed at a time is "not
schedulable there". §8 says pins "are never moved or dropped, even when that produces a worse
overall day". A user who pins a stop to 20:00 at a place that shuts at 19:00 triggers both rules.
**Decision:** Read §7c as constraining what the *scheduler* may choose, and §8 as constraining what
it may *override*. The pin is honoured exactly, and the day carries a `--caution` warning naming the
stop and the time ("You pinned Livraria Lello to 20:00, but it looks closed then"). The scheduler
never selects a closed slot on its own; the traveller may, knowingly. Flagged per §12.
**Rejected:** Silently moving the pin to the nearest open time — §8 forbids it and it makes the app
feel like it is arguing. Dropping the pinned stop — same. Honouring it with no warning — that is
exactly the untrustworthy behaviour §7c exists to prevent.

### `Poi` carries a `category` field beyond the §3 model
**Context:** §3 fixes the `Poi` shape and `tags: InterestTag[]` drives interest matching. But §7b
needs to tell a restaurant from a museum to fill meal slots, and §9c asks a stop block to show its
category. Deriving either from interest tags means sniffing (`tags.includes("food")`), which
misclassifies markets and cafés.
**Decision:** Added `category: CategoryKey | null`, keyed to the catalogue in
`src/shared/categories.ts`. `tags` is untouched and still drives §6a scoring. Null for user-added
places.
**Rejected:** Inferring meal venues from tags — a market carries `food` but is a sight, not a lunch
booking. Keeping a side map from POI id to category — the same data, one indirection further away,
and it would have to be threaded through every call.

### Restaurants and cafés are held out of the sightseeing pool
**Context:** §7b wants a ranked food POI in the meal slot when food matters. If restaurants also
compete as ordinary stops, a food-forward trip schedules a restaurant as a sight at 15:00 and then
schedules lunch as well.
**Decision:** `restaurant` and `cafe` categories go only into the meal pool. Markets stay sights — a
market is somewhere you go, not only somewhere you eat. Venues are never reused across the stay, nor
between lunch and dinner on the same day.
**Rejected:** Letting food POIs compete in both pools with a de-duplication pass afterwards — the
scoring then has to compare "worth a stop" against "worth a meal", which are not the same question.

### Undated stays get a typical week's hours, not the union of all days
**Context:** A `CityStay` may give only a day count, so the weekday is unknown and OSM rules cannot
be evaluated against a real date.
**Decision:** Resolve hours against a fixed reference week and use the *median* weekday by open
minutes, then mark the day as unverified with a plain-language warning. The union across weekdays
would claim a Monday-closed museum is open on Monday, which is the exact failure §7c exists to stop;
the intersection would drop it from the plan entirely.
**Rejected:** Refusing to plan without dates — §4 requires generation never to block on missing
input. Assuming today's weekday — silently wrong for a trip three months out.

### k-means is balanced by capacity before days are assigned
**Context:** Plain k-means on POI coordinates regularly returns one cluster of fourteen and one of
two, which produces one exhausting day and one empty one.
**Decision:** After k-means converges, cap each cluster at `ceil(n/k)` and move the worst-fitting
members of oversized clusters to the nearest cluster with room. Seeding is k-means++ with an RNG
seeded from the input coordinates, so the same candidate set always yields the same plan — a planner
that reshuffles the whole trip when you remove one stop is not trustworthy.
**Rejected:** A constrained k-means variant solved as min-cost flow — correct but far more code than
a 20-POI, 7-cluster problem justifies.

### Cluster-to-day assignment by pairwise swaps rather than a Hungarian solver
**Context:** §7a step 3 requires days to dodge weekday closures: a cluster full of Monday-closed
museums must not land on the Monday.
**Decision:** Build a day × cluster penalty matrix (sum of scores lost to closures, plus a small
distance term pulling clusters toward whatever the user pinned to that day) and improve an identity
assignment with exhaustive pairwise swaps until nothing improves. Stays under a millisecond for the
30-day worst case.
**Rejected:** A full Hungarian implementation — optimal, but ~150 lines to beat swaps on a problem
this size by nothing measurable.

### OSRM's public demo server has no walking profile
**Context:** §5d says to use OSRM for walking and driving matrices. Measured against Porto,
`/table/v1/foot/...`, `/walking/`, `/driving/` and `/car/` all return byte-identical numbers, and
those numbers are car speeds (1962 m in 224 s ≈ 32 km/h through the centre). The public demo server
runs the car profile and ignores the profile in the URL.
**Decision:** Use OSRM for what it genuinely provides — real road-network *distances* — and derive
walking time from those at a stated pace (`WALK_SPEED_M_PER_MIN`). Car mode uses OSRM's durations
directly, which is what they actually are. The matrix is flagged `approximate` for every mode but
car, and the UI says so.
**Rejected:** Passing off driving times as walking times — it would have made every walking day look
three times faster than it is, which is the fake-precise wrong number §5d warns against. A paid
routing provider — §12 says report the degradation instead. Self-hosting an OSRM foot profile is the
real fix and is noted in the README.

### Overpass: bbox beats `around`, and one named set per category beats one pooled set
**Context:** The first Overpass query used `(around:6000,lat,lng)` per selector and pooled every
category into one set with one `out` limit. It timed out at 93 seconds. Widening the limit and
switching to a global `[bbox:]` fixed the timeout (7 seconds, 360 objects) but the returned set
contained neither Livraria Lello nor Igreja de São Francisco: a few hundred artwork nodes had
consumed the pooled limit.
**Decision:** Global `[bbox:]` for the spatial filter, and one named set with its own `out` limit per
category (`fetchLimit` on the catalogue entry). Porto now returns 1,125 objects in about 7 seconds
with the landmarks present, and the Wikivoyage match rate doubled from 10/61 to 20/61. Still one
HTTP request, as §10 requires.
**Rejected:** A `nwr["wikidata"][name]` "notable objects" set to guarantee landmark coverage — an
unindexed key scan over the bbox, and it 504'd.

### Overpass reports a timeout as HTTP 200, which read as "no places here"
**Context:** A server-side timeout comes back as HTTP 200 with `elements: []` and a `remark` field.
The first version of the fixture recorder accepted that and wrote a fixture with zero OSM data, and
the pipeline would have presented a Wikivoyage-only itinerary as if nothing were wrong.
**Decision:** Inspect `remark` and throw. Exactly the empty success §11c forbids.

### Public-holiday rules were silently deleting real museums
**Context:** `Tu-Su 10:00-18:00; PH off` is an ordinary museum tag and it is everywhere — 29 of
Porto's candidates carry a `PH` clause. The reference parser *constructs* such a value happily but
*throws on evaluation* unless it knows which country's holiday table applies, and the first version
passed `country_code: ""`. The throw was caught and treated as "no open windows", i.e. closed all
day, so those places were dropped from every itinerary with the reason "Closed Mondays".
**Decision:** Two layers. `CityStay` now carries `countryCode` from the geocoder, so holiday rules
resolve exactly. When it is missing, the value is re-parsed with its holiday clauses stripped and the
result is flagged uncertain, which surfaces as a §9d warning. Silent deletion was by far the worst
of the three options.
**Rejected:** Treating an unevaluable value as fully unknown hours — it discards a perfectly good
weekly schedule. Bundling a holiday table — a maintenance liability for a single-user app.

### The LLM is constrained by schema *and* by validation, not by prompt alone
**Context:** §6b's rule that the model may never produce a place name is the single most important
correctness rule in the brief, and a prompt asking nicely is not a mechanism.
**Decision:** Three layers. Every POI-touching call receives candidates as `id | name | tags` lines
and is constrained by a JSON schema whose only place-shaped field is a string id; every returned id
is checked against the input set in `validateIds`; anything unrecognised is discarded and logged as
a bug. Structured outputs (`output_config.format`) rather than prompted JSON, so malformed output is
impossible rather than merely unlikely. Claude Haiku 4.5 — none of the three jobs needs a frontier
model (§10).
**Rejected:** Putting the candidate ids in a JSON-schema `enum`, which would make an invented id
structurally impossible. It compiles a new schema per call (the schema cache is keyed by shape), and
the validation layer already catches the case; the enum would trade a one-time latency cost on every
generation for a check that costs nothing.

### Restaurants and cafés are the meal pool; Wikivoyage "Do" listings became their own category
**Context:** Two mislabelling problems showed up in the recorded Porto ranking: FC Porto and Boavista
FC were classified as `neighbourhood` (a 90-minute wander), because that was the fallback category
for a Wikivoyage "Do" listing.
**Decision:** Added an `activity` category (90 min, no Overpass selectors — Wikivoyage-only, since a
stadium tour or a river cruise has no single OSM tag) and made it the "Do" default, plus name hints
for stadium/cruise/tour wording. The duration was already about right; the label was the lie.
**Rejected:** Inventing an OSM selector for activities — that would generate places rather than find
them.

### The rail was not proportional until it was measured
**Context:** §9a's proportional rail was implemented with
`min-height: calc(var(--block-minutes) * var(--px-per-min) * 1px)` and looked plausible. Measuring
the rendered boxes in a browser showed it was wrong in the direction that matters: a 30-minute stop
rendered 149px and a 120-minute stop 126px, because content height dominated the minimum. §11b's
criterion was failing while the CSS looked like it implemented it.
**Decision:** `height`, not `min-height`, so duration is the only input; then everything inside a
stop block sized to fit the shortest block the scale produces — the action row moved out of flow
(an invisible row was eating a third of a short block), the meta row pinned to the block's foot so
it can never be the thing that gets clipped, and the rationale clamped to fill what is left. The
scale was raised to 3.4 px/min, chosen so a 30-minute stop still holds a name, two lines of reason
and a meta line. Now measured at exactly 3.40 px/min across every block, in the app and in the export.
**Rejected:** Keeping `min-height` and hoping content stayed short — that is the same bug waiting for
a longer place name. Clipping the rationale on short stops — §9c gives it real space on purpose.

### Long gaps are the one thing on the rail not drawn to scale
**Context:** A day with a three-hour hole rendered 620px of empty rail. That is proportional and
true, and it also tells the reader nothing the label "3 hr 2 min free" does not.
**Decision:** Slack blocks cap at 9rem and carry a break mark when capped; the label always states
the real duration. Stops and meals stay exactly proportional, which is what §11b tests and what
makes the shape of the day honest.
**Rejected:** Capping stops too — that would undo the whole point. Hiding long gaps — a three-hour
hole is something the traveller should see.

### The export carries the CSSOM, not a second stylesheet
**Context:** §9f requires the exported page to render fully offline. It needs the app's styles, and
a hand-maintained copy would drift from the app within a week.
**Decision:** Read every rule out of `document.styleSheets` at export time, drop the `@font-face` and
`@import` rules, and substitute the base64 font faces from `public/fonts/inline.css`. The map becomes
an inline SVG of the day's route with a scale bar, drawn from coordinates the itinerary already
carries. Verified by loading the result with every outbound request aborted: 0 requests attempted,
fonts loaded, route drawn, no overflow.
**Rejected:** A static map image from a tile provider — a network call at export time and a licence
question. Omitting the map, which §9f permits — the SVG costs 2 KB and answers "which way do I walk".

### Browser checks live in scripts, not in the test suite
**Context:** Three §11b criteria — rail proportionality, the offline export, print pagination — are
facts about rendered layout. They cannot be asserted from the data model, which is exactly how the
rail bug survived.
**Decision:** `scripts/preview.ts` and `scripts/verify-export.ts` drive a headless Chromium against a
running dev server and assert the rendered numbers. They are not in `npm test` because that must
stay runnable with `FIXTURE_MODE=true` and no server (§11b); they are run by hand at each UI change
and are documented in the README.
**Rejected:** jsdom in the unit suite — it does not do layout, so it would have reported the broken
rail as passing.

### A deterministic reason line, for when the LLM is not there
**Context:** §6c gives rationale writing to the LLM; §10 turns it off by default; with no key it
never runs. The itinerary renders correctly with every rationale null, as §6c requires — but a stop
with no reason at all reads as arbitrary, which is what §9c says the rationale is for.
**Decision:** `plainWhy` states which of the traveller's own interests the place matched and whether
Wikivoyage singled it out. Every clause comes from data already on the POI; nothing is generated. An
LLM rationale replaces it whenever one exists.
**Rejected:** Leaving the space blank — it makes a considered plan look arbitrary. Writing a
template sentence with adjectives in it — that is generation with extra steps, and it would be the
first place a fabricated claim about a place could creep in.

### A three-city live trip found six bugs at once
**Context:** The first real run outside the fixture cities — Tokyo, Kyoto and Osaka, nine days —
failed with `fetch failed` after a storm of 429s. Each cause was separate and all but one were mine.
**Decision:** Fixed in order of blame:
1. **StrictMode fired every generation twice.** The mount effect guarded on `status === "idle"`, but
   `setStatus("working")` has not committed when StrictMode's second pass runs, so both saw idle.
   Two generations in flight held both of Overpass's two per-IP slots and rate-limited the app
   against itself. Now guarded by a ref.
2. **Nothing gated outbound concurrency.** Added `limiter.ts`: one Overpass query at a time (half
   the published allowance), one OSRM call, two Wikimedia. On the server, so it holds whatever the
   client does.
3. **The query never asked whether a slot was free.** Overpass publishes its own rate-limit state
   at `/api/status`, including "Slot available after: …, in N seconds". Now consulted before each
   query rather than firing and being refused.
4. **Non-English city names lost the entire editorial signal.** Nominatim answers "Kyoto" with
   京都市, and English Wikivoyage returns `missingtitle` for that. Added `name:en` to the geocode
   request; `CityStay` carries `englishName` and Wikivoyage is tried in English first.
5. **`fetch failed` reached the user.** §9g says errors are never vague. `travellerFacingError`
   now maps upstream failures to something that says what happened and what to do.
6. **Retry backoff was far too eager** at 4s, since the retry itself claims a slot. Now 10s
   doubling to 60s, and it honours `Retry-After`.

### Overpass mirrors, and the day the main instance went down
**Context:** Mid-session, `overpass-api.de` began returning 504 "Dispatcher_Client::…timeout. The
server is probably too busy" for *every* query — including a 200-metre single-selector probe — while
reporting 2 free slots. That is the backend, not the rate limiter, and no amount of politeness on
our side fixes it.
**Decision:** Fall back across free, keyless Overpass mirrors (`OVERPASS_FALLBACK_URLS`, defaulting
to private.coffee and kumi.systems), with a five-minute circuit breaker so a multi-city trip pays
for a dead host once rather than once per city. This is §12's "report, do not switch to a paid
provider" — the same provider on another host, still free, still keyless. The outage itself is
reported in the README and above.
**Rejected:** Waiting it out — the app would simply be broken for the duration. A paid geodata API —
ruled out by §0b.

### The query was too expensive for a dense city, and `out N` does not help
**Context:** Even on a healthy mirror, Tokyo exceeded 180 seconds. The instinct to blame server load
was wrong: `out N` caps *output*, not the scan, so cost tracks how much matches, not how much is
returned. Porto (1,125 objects) took 7s; Tokyo timed out.
**Decision:** Two structural changes, measured. Categories that are almost always a single point —
café, restaurant, bar, viewpoint, artwork, shrine — search `node` instead of `nwr`, cutting the index
work to a third for exactly the densest categories. And the search box shrank from 6 km to 4 km,
which is not a performance hack dressed as product: §7d caps daily walking at 12 km *in total*, so a
place 6 km out was never going to be scheduled. Tokyo went from >180s to **14.6s**.
**Rejected:** Fewer, pooled category sets — that is the truncation bug that lost Porto's landmarks.
Shrinking to 1.2 km — measured no better on a weak mirror, and it would cut real attractions.

### Big cities keep their attractions in district sub-articles
**Context:** With the English title fixed, Tokyo's Wikivoyage article parsed to 97 listings and every
one was an embassy under "Cope"; Osaka's held only "Get in" and "Cope" entries. Both cities were
being ranked on OpenStreetMap alone, and embassies named "Georgia" and "Sweden" were being scheduled
as monuments.
**Decision:** Two parts. Restrict listings to the sections §5a actually names — See, Do, Eat, Drink
(plus Buy) — which removes the embassies. Then, when a parent article is thin, follow its
`[[City/District]]` links and parse up to eight of them; they appear in editorial order, so the first
few are the central districts. Prominence stays per-article, since 3rd of 20 in a district guide
beats 3rd of 200 across eight. Tokyo, Kyoto and Osaka now produce their canonical landmarks with no
degradation warnings.
**Rejected:** Accepting OSM-only ranking for large cities and reporting it, which is what §12 permits
— defensible, but the signal was there and one convention away.

### Place names are shown in English and in the local script
**Context:** 3,069 of Tokyo's 3,353 candidates carry a Japanese `name`. An itinerary of 迎賓館 and
赤坂 is unreadable to whoever asked for it; one that shows only English is useless for reading a
street sign. Worse, `normaliseName` stripped everything outside `[a-z0-9]`, so every Japanese name
normalised to an empty string and name matching silently scored zero against everything.
**Decision:** Display OSM's `name:en` when it exists (693 of 1,160 Tokyo objects have one) and keep
`name` as `Poi.localName`, shown beside it in the rail and the export. `normaliseName` now keeps
`\p{L}\p{N}`, so local-script names can match each other too.
**Rejected:** Showing only the local name, or only the English one — each is useless in the
situation the other covers.

### The exported "map" was four dots on an empty field
**Context:** Reported after a real export: "the maps are not visible". They were rendering — the
verification measured one 688px wide and passed — but the check only ever asserted *width*, and the
drawing itself was a dashed line between numbered circles on blank grey. No streets, no river, no
orientation. It did not read as a map, which is indistinguishable from not being there.
**Decision:** Two things. The export now fetches OpenStreetMap tiles for each day's bounding box at
export time, composes them on a canvas with the route drawn over, and embeds the result as a single
data URI — §9f's "static image", and the version that answers "which way do I walk from here". The
tile server sends `access-control-allow-origin: *`, so the canvas stays untainted and the page still
needs no network to display. Zoom is chosen so a day fits in at most twelve tiles, requests go three
at a time, and attribution is rendered into the caption. When tiles cannot be fetched the old
schematic remains as a fallback and its caption says why.
**Rejected:** Leaving it schematic and explaining it — the complaint was correct. A tile-server proxy
or a paid static-map API — unnecessary and, for the latter, ruled out by §0b.

### The verification measured width but not height
**Context:** The map check asserted `svgWidth > 200`. A zero-height element still reports its full
width, so the check could not have caught the class of bug it existed to catch, and my first
hypothesis about the report — that WebKit was collapsing a viewBox-only SVG to zero height — was
plausible enough that I nearly shipped a fix for it. Measuring both dimensions in both engines
disproved it in about a minute.
**Decision:** Assert width *and* height, and run the whole export pass a second time in WebKit,
since Safari is the engine most likely to differ and the one a Mac user opening a downloaded file
will actually use. Both now pass at 688×668.
**Rejected:** Trusting the hypothesis and fixing the SVG sizing without reproducing — it would have
left the real problem untouched while looking like a fix.
