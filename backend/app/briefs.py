"""One-page briefs in Markdown, built only from numbers the app has already computed."""

from __future__ import annotations

from datetime import datetime

from .config import settings


def _when(iso: str) -> str:
    return datetime.fromisoformat(iso).strftime("%a %d %b %Y, %H:%M UTC")


def _pass_rows(passes: list[dict], limit: int) -> str:
    rows = ["| Time | Satellite | Incidence | Optical at that moment |", "|---|---|---|---|"]
    label = {"night": "blind (night)", "cloud": "blind (cloud)", "clear": "could also see"}
    for p in passes[:limit]:
        rows.append(f"| {_when(p['time'])} | {p['satellite']} | {p['incidence_deg']} deg | {label.get(p.get('optical'), 'unknown')} |")
    return "\n".join(rows)


def _limits() -> str:
    return (
        "## How these numbers were made\n\n"
        f"- Passes: public orbit data (CelesTrak) propagated with SGP4. A look is counted when the incidence angle is "
        f"between {settings.min_incidence_deg:g} and {settings.max_incidence_deg:g} degrees. Satellite availability is not checked.\n"
        f"- Optical blind: night from sun elevation, cloud from the NOAA GFS forecast (1 degree grid), threshold {settings.cloud_blind_pct:g}%.\n"
        "- People nearby: cities above 15,000 people within 100 km (GeoNames). Rural population is not counted.\n"
        "- This is a planning estimate, not a delivery commitment.\n"
    )


def event_brief(e: dict) -> str:
    f, x, o = e["first_look"], e.get("exposure") or {}, e["optical"]
    cities = ", ".join(f"{c['name']} ({c['population']:,})" for c in x.get("cities", [])) or "none listed"
    lines = [
        f"# {e['title']}",
        "",
        f"**{e['type'].title()}**, {e['severity_label']}. Reported {_when(e['time'])} by {', '.join(s['name'] for s in e['sources'])}.",
        f"Location: {e['lat']:.2f}, {e['lon']:.2f}.",
        "",
        "## Why radar, and why now",
        "",
        f"- **First radar look:** {_when(f['time']) + ' (' + f['satellite'] + ')' if f else 'none in the next 72 hours'}.",
        f"- **Looks available:** {e['looks_24h']} in 24 hours, {e['looks_72h']} in 72 hours.",
        f"- **Optical satellites are blind {o['blind_fraction']:.0%} of the next {o['hours']} hours** "
        f"(night {o['night_fraction']:.0%} of the time" + (f", mean cloud cover {o['cloud_mean']}%" if o.get("cloud_mean") is not None else ", cloud forecast unavailable") + ").",
        f"- **Radar-only looks:** {e['radar_only_looks']} of the {e['looks_72h']} looks in 72 hours fall at night or under heavy cloud.",
        f"- **People in cities within 100 km:** {x.get('population', 0):,}. Largest: {cities}.",
        "",
        "## Next radar looks",
        "",
        _pass_rows(e["passes"], 8),
        "",
        f"## Priority {e['priority']['value']} / 100",
        "",
        "| Term | Value | Basis |",
        "|---|---|---|",
        *[f"| {t['term']} | {t['value']:.2f} | {t['source']} |" for t in e["priority"]["terms"]],
        "",
        _limits(),
    ]
    return "\n".join(lines)


def order_brief(r: dict) -> str:
    o, f = r["order"], r["feasibility"]
    lines = [
        f"# Tasking order {r['id']}: {o.get('location_name') or 'location unclear'}",
        "",
        f"Status: **{r['status'].replace('_', ' ')}**. Created {_when(r['created_at'])} by {r['created_by']}.",
        "",
        "## Request",
        "",
        f"> {r['raw_text']}",
        "",
        f"- Customer: {o.get('customer') or 'not stated'}",
        f"- Area: {o.get('latitude')}, {o.get('longitude')} ({r.get('country') or 'open sea'}), radius {o.get('radius_km')} km",
        f"- Imaging: {o.get('imaging_mode')} mode, {'every ' + format(o['revisit_hours'], 'g') + ' hours' if o.get('revisit_hours') else 'once'}, {o.get('priority')} priority",
    ]
    if o.get("open_questions"):
        lines += ["", "## To confirm", "", *[f"- {q}" for q in o["open_questions"]]]
    if f:
        ro = f.get("radar_only") or {}
        lines += [
            "", "## Feasibility", "",
            f"**{f['verdict'].replace('_', ' ').title()}.** {f['reason']}",
            "",
            f"- {f['opportunities']} looks in 7 days from {f['satellites_used']} satellites; longest gap {f['max_gap_hours']} hours.",
            f"- {ro.get('night', 0) + ro.get('cloud', 0)} of those looks fall when optical satellites are blind.",
        ]
        if f.get("conflicts_avoided"):
            lines.append(f"- {len(f['conflicts_avoided'])} planned slot(s) moved to another pass because the satellite was booked by another order.")
        lines += ["", "## Planned collections", "", _pass_rows(f.get("plan", []), 20)]
    lines += ["", "## Approvals", ""]
    lines += [f"- {a['role']}: {a['decision']} by {a['actor']}, {_when(a['ts'])}" for a in r["approvals"]] or ["- none yet"]
    if r["outstanding_roles"]:
        lines.append(f"- waiting for: {', '.join(r['outstanding_roles'])}")
    lines += ["", _limits()]
    return "\n".join(lines)
