# Orbit Desk

A tasking console for a radar (SAR) satellite operator. It answers one
question continuously: **where in the world does radar imaging matter most
right now, and how soon can we look?**

[![Orbit Desk: 10-second demo](docs/demo.gif)](docs/demo.mp4)

*10-second demo ([MP4, 1600×900](docs/demo.mp4)): pick the top event and the
globe flies to it with its countdown to the first radar look, time runs at ×600
so the satellites sweep past, then the latency map shows how soon any place on
Earth can be imaged.*

It watches public event feeds, computes from real orbits when a satellite can
image each event, measures how blind optical satellites are there (night and
cloud), and ranks the events. One click turns an event into a tasking order,
which then goes through fixed approval rules, simulated CRM and ticket writes,
and a tamper-evident audit log. Sales can also type a customer request in plain
words and get the same analysis.

## Run it

```bash
cp .env.example .env      # optional: add ANTHROPIC_API_KEY to use Claude
make up                   # then open http://localhost:8000
make test
```

Only Docker is needed. No API keys are required for any data feed; `KEYS.md`
lists the optional ones. City data is from GeoNames (CC BY 4.0). Without an
Anthropic key, typed requests are read by a simple rule-based parser.

## What it does

**Watch board.** Earthquakes (USGS), disaster alerts and floods (GDACS) and
storms and wildfires (NASA EONET) are fetched every 10 minutes and merged, so the same event reported
by two feeds appears once. For each event the backend computes:

| Number | How |
|---|---|
| Time to first radar look | SGP4 propagation of the 53 public ICEYE orbits (CelesTrak) |
| Looks in 24 h and 72 h | Same propagation, shared across all events |
| Optical-blind share | Hours that are night (sun below the horizon) or at least 70% cloud (NOAA GFS forecast) |
| People nearby | Population of cities within 100 km, from a bundled GeoNames list |
| Priority | `100 x severity x radar advantage x freshness x people nearby`, with every term and its source shown |

**Latency map.** The LATENCY MAP switch colours the whole globe by how long
it would take a radar satellite to first look at each place, using the same
orbit model as everything else, on a 4° grid over the next 24 hours (rebuilt
every 10 minutes, about 10 seconds of NumPy per rebuild). Short waits stay
clear; the gaps between orbits show up as orange bands, and places with no look
at all are hatched. Hover any point for its wait and number of looks. A panel
shows area-weighted figures (typical wait, the wait 9 in 10 places beat, share
reachable within 1 and 3 hours) and the typical wait at every latitude.
`GET /api/coverage` returns the grid and `GET /api/coverage/at?lat=&lon=` one
cell. A test checks every grid cell against the single-target pass search.

**Event dossier.** A live countdown to the first look, a strip showing night,
cloud and every radar pass on one time axis, and the priority calculation.

**Tasking orders.** Created from an event or from free text. Each order gets a
7-day feasibility check, a collection plan that avoids satellites already
booked by other open orders, a downloadable Markdown brief, a revisit comparison against two
other radar constellations (Capella, Umbra, same model and public orbits), and
approval rules evaluated from its coordinates.

**Integrations.** On final approval the app creates a Jira ticket (real when
`JIRA_*` is set, simulated otherwise) and a simulated Salesforce deal. Writes
are idempotent; a failed write leaves the order approved, logs the error and
offers a retry. Slack messages go out for new orders, decisions and new
high-priority events when `SLACK_WEBHOOK_URL` is set.

**Analyst (Ask tab).** Claude answers questions such as "which floods can we
image before 06:00 UTC?" by calling seven read-only tools over the console's
own data (watch board, events, pass prediction, city lookup, population,
orders). Every lookup is shown under the answer and logged. It has no tool that
can create, approve or send anything. The event dossier can also draft an
outreach email for an insurer, agency, NGO or port operator, using only that
event's computed facts; nothing is sent.

**Approvals and audit.** Every order needs a sales manager. An area in a
restricted country also needs a compliance officer. Nobody approves their own
request. Every step is written to a hash-chained log; `GET /api/audit/verify`
reports the first entry that was edited or deleted.

**Globe.** Drawn from scratch with three.js: Natural Earth outlines painted to
a texture, dotted land, a day/night line, satellites moving on their real
orbits, pulsing event markers, the ground track of upcoming passes, and green
links to any satellite that could image the selected target at this moment.

## The AI can suggest, but it cannot decide

Try the "Injection test" under Intake. The text claims the order is
pre-approved and tells the system to skip the review. Approval rules look only
at where the coordinates fall, so the order is still held for compliance, and a
refused approval attempt is logged.

## Stack

| Part | Choice |
|---|---|
| API | Python, FastAPI, SQLAlchemy 2, Alembic |
| Database | PostgreSQL, tables in a dedicated `orbitdesk` schema |
| Orbit maths | `sgp4` + NumPy, one ephemeris reused for every target |
| AI | Claude through the Anthropic SDK, structured output |
| Dashboard | TypeScript, React, Vite, three.js, satellite.js |
| Packaging | One multi-stage Docker image, Docker Compose |

## Honest limits

- **Feasibility is a simplified model.** A look is counted when a satellite's
  closest approach has an incidence angle between 15° and 45°. These limits are
  assumptions, not vendor specifications. Every catalogued satellite is treated
  as working and free. The constellation comparison uses the same model, so it
  shows orbit geometry only, not real capacity.
- **"Optical blind" is an estimate**: night from sun elevation, cloud from a
  forecast with a fixed 70% threshold.
- **Priority is a transparent heuristic**, not a validated model. Severity
  scales differ by event type.
- **No target location leaves the app.** The cloud forecast is downloaded as
  whole-world files from NOAA and looked up locally; city lookups and country
  checks use bundled data. The only thing sent to Anthropic is the text of a
  typed request, when a key is set. `INTEL_ENABLED=false` turns all feeds off.
- **Cloud data is coarse**: a 1° grid (about 100 km), every 3 to 6 hours.
- **People nearby counts cities above 15,000 only**, so rural areas read as zero.
- **Conflict avoidance is simple**: one satellite cannot serve two orders
  within 10 minutes. It is not a full scheduler.
- **Salesforce and Jira are simulated**, and sign-in is a demo switcher.
- **The restricted-country list is an example**, not legal advice.
- Pass geometry was cross-checked against a second SGP4 library (satellite.js):
  293 passes agreed to within 0.7° of incidence angle.
- Independent portfolio project using only public data. Not affiliated with ICEYE.

## Layout

```
backend/app/orbits.py      orbit data, ephemeris, pass search, sun elevation
backend/app/coverage.py    worldwide latency map: first look per grid cell, area-weighted stats
backend/app/osint.py       event feeds, fusion, space weather
backend/app/cloud.py       NOAA GFS cloud forecast, whole-world download
backend/app/geo.py         offline city database: people nearby, geocoding
backend/app/briefs.py      Markdown briefs for events and orders
backend/app/agent.py       analyst: tool definitions, capped loop, outreach drafts
backend/app/connectors.py  Jira (real or simulated), Salesforce (simulated), Slack
backend/app/watch.py       watch board: optical profile, priority score
backend/app/parser.py      Claude parser and rule-based fallback
backend/app/policy.py      approval rules, country lookup
backend/app/audit.py       hash-chained audit log
backend/app/main.py        API and workflow
frontend/src/globe/        the 3D globe and its overlay
frontend/src/components/   dossiers, visibility strip, timeline
```
