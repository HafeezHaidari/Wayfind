# DOCUMENTATION

## Current State
<!-- OVERWRITE this whole section on every update. Do not append. -->

**Stage:** 1 of 8 complete — preference interview UI + preference model (§0d stage 1).
**Verified working:** Preflight (§0c): Node v22.14.0, npm 10.9.2; Overpass, OSRM, Wikivoyage,
Wikidata and Nominatim all reachable; no LLM key set. Project scaffold (Vite + React + TS client,
Express pipeline server, Vitest). Fonts self-hosted in `public/fonts/` (§9f rules out CDN fonts).
Design tokens (§9b) defined. Trip setup screen with live Nominatim geocoding, and the full nine-step
interview (§4) producing a `TripBrief`. `npx tsc --noEmit` clean, `npm run build` succeeds,
`GET /api/status` and `GET /api/geocode?q=Porto` answer correctly against live Nominatim.
**In progress:** Nothing — stage 1 is closed.
**Next action:** §0d stage 2 — the scheduler (§7) as a pure function over synthetic POIs and
synthetic travel times, with the opening-hours test suite (§11b) written first and comprehensively.
**Blocked / unverified:** No `ANTHROPIC_API_KEY` in the environment, so the §6b LLM layer will be
built and unit-tested but cannot be verified against a live model this session; it must degrade to
null rationales and the deterministic free-text fallback. No live test city was supplied, so Porto
is the fixture city. `/api/generate` currently throws by design (pipeline arrives in stages 3-5).
**Active deviations from spec:** One, minor: §0d calls stage 1 "pure client-side, no data sources",
but the trip setup screen needs a geocoder to fill `CityStay.lat/lng`, so a `/api/geocode` endpoint
(Nominatim) was built alongside it. No POI sourcing or scheduling was pulled forward.
**Last updated:** Stage 1 complete and committed.

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
