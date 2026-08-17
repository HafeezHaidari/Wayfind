# DOCUMENTATION

## Current State
<!-- OVERWRITE this whole section on every update. Do not append. -->

**Stage:** 2 of 8 complete — the scheduler (§0d stage 2).
**Verified working:** Preflight (§0c): Node v22.14.0, npm 10.9.2; Overpass, OSRM, Wikivoyage,
Wikidata and Nominatim all reachable; no LLM key set. Project scaffold (Vite + React + TS client,
Express pipeline server, Vitest). Fonts self-hosted in `public/fonts/` (§9f rules out CDN fonts).
Design tokens (§9b) defined. Trip setup screen with live Nominatim geocoding, and the full nine-step
interview (§4) producing a `TripBrief`. The scheduler (§7) as a pure function: opening-hours
resolution over the real OSM grammar, geographic clustering, cluster-to-day assignment that routes
around weekday closures, nearest-neighbour + 2-opt sequencing, timeline layout with meals, realism
guards and recorded drops. 81 tests pass (`npx vitest run`), including the comprehensive
opening-hours suite §11b asks for first. `npx tsc --noEmit` clean, `npm run build` succeeds.
**In progress:** Nothing — stage 2 is closed.
**Next action:** §0d stage 3 — POI sourcing (§5) against Porto, with fixtures recorded:
Overpass query builder, Wikivoyage parsing, Wikidata sitelinks, name+proximity matching, dedupe.
**Blocked / unverified:** No `ANTHROPIC_API_KEY` in the environment, so the §6b LLM layer will be
built and unit-tested but cannot be verified against a live model this session; it must degrade to
null rationales and the deterministic free-text fallback. No live test city was supplied, so Porto
is the fixture city. `/api/generate` currently throws by design (pipeline arrives in stages 3-5).
**Active deviations from spec:** Three, all minor and all logged below: `/api/geocode` was built
during stage 1 although §0d calls that stage pure client-side; `Poi` carries an added
`category` field; a stop pinned to a time may sit outside the POI's hours (§7c vs §8, resolved in
favour of §8 with a visible warning).
**Last updated:** Stage 2 complete and committed.

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
