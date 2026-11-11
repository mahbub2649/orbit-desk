"""The watch board: every live event, scored by how much radar imaging matters there.

For each event the board answers three questions from data:
1. How soon can a radar satellite image it?            (orbit propagation)
2. How blind are optical satellites there?             (night + cloud forecast)
3. How severe and how fresh is it?                     (the event feeds)
"""

from __future__ import annotations

import logging
import math
import threading
import time
from datetime import datetime, timedelta, timezone

from . import cloud, connectors, geo, orbits, osint
from .config import settings

log = logging.getLogger(__name__)

_state: dict = {"status": "loading", "updated_at": None, "feeds": [], "kp": None, "events": []}
_lock = threading.Lock()


def optical_profile(lat: float, lon: float, start: datetime, hours: int) -> dict:
    """Hour-by-hour view of whether an optical satellite could see the ground."""
    times = [start.replace(minute=0, second=0, microsecond=0) + timedelta(hours=h) for h in range(hours)]
    sun = orbits.sun_elevation_deg(times, lat, lon)
    strip, blind = [], 0
    for t, el in zip(times, sun):
        pct = cloud.at(lat, lon, t)
        night = bool(el < 0)
        cloudy = pct is not None and pct >= settings.cloud_blind_pct
        blind += night or cloudy
        strip.append({"night": night, "cloud": pct})
    known = [s["cloud"] for s in strip if s["cloud"] is not None]
    return {
        "start": times[0].isoformat(), "hours": hours, "strip": strip,
        "blind_fraction": round(blind / hours, 2),
        "night_fraction": round(sum(s["night"] for s in strip) / hours, 2),
        "cloud_mean": round(sum(known) / len(known)) if known else None,
        "cloud_available": bool(known),
    }


def tag_passes(passes: list[dict], lat: float, lon: float) -> None:
    """Add to each pass whether an optical satellite could have taken the same image."""
    for p in passes:
        t = datetime.fromisoformat(p["time"])
        el = orbits.sun_elevation_deg(t, lat, lon)
        pct = cloud.at(lat, lon, t)
        p["sun_elevation_deg"] = round(el)
        p["cloud_pct"] = pct
        p["optical"] = "night" if el < 0 else "cloud" if pct is not None and pct >= settings.cloud_blind_pct else "clear"


def score(event: dict, now: datetime) -> dict:
    age_days = max(0.0, (now - event["time"]).total_seconds() / 86400)
    freshness = max(0.2, math.exp(-age_days / 4))
    blind = event["optical"]["blind_fraction"]
    advantage = 0.5 + 0.5 * blind
    people = (event.get("exposure") or {}).get("population")
    reach = 1.0 if people is None else 0.6 + 0.4 * min(1.0, math.log10(people + 1) / 7)
    value = round(100 * event["severity"] * advantage * freshness * reach)
    return {
        "value": value,
        "terms": [
            {"term": "Severity", "value": round(event["severity"], 2), "source": f"{event['sources'][0]['name']}: {event['severity_label']}"},
            {"term": "Radar advantage", "value": round(advantage, 2), "source": f"0.5 + 0.5 x optical-blind share ({blind:.0%} of the next {event['optical']['hours']} h)"},
            {"term": "Freshness", "value": round(freshness, 2), "source": f"exp(-age / 4 days), age {age_days:.1f} days"},
            {"term": "People nearby", "value": round(reach, 2),
             "source": "not available" if people is None else f"0.6 + 0.4 x log10(people) / 7; {people:,} people in cities within 100 km (GeoNames)"},
        ],
        "formula": "100 x severity x radar advantage x freshness x people nearby",
    }


def build() -> dict:
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    events, feeds = osint.collect_events()
    events = events[:80]
    hours = int(settings.watch_horizon_hours)
    sats = orbits.load_satellites()["satellites"]
    eph = orbits.ephemeris(sats, now, hours, step_s=30)

    out = []
    for e in events:
        passes = orbits.passes_from(eph, e["lat"], e["lon"])
        tag_passes(passes, e["lat"], e["lon"])
        e["optical"] = optical_profile(e["lat"], e["lon"], now, hours)
        e["exposure"] = geo.exposure(e["lat"], e["lon"])
        first = passes[0] if passes else None
        within = lambda h: sum(datetime.fromisoformat(p["time"]) <= now + timedelta(hours=h) for p in passes)  # noqa: E731
        out.append({
            **{k: e[k] for k in ("id", "type", "title", "lat", "lon", "severity", "severity_label", "detail", "sources")},
            "time": e["time"].isoformat(),
            "optical": e["optical"],
            "exposure": e["exposure"],
            "first_look": first and {**first, "hours_from_now": round((datetime.fromisoformat(first["time"]) - now).total_seconds() / 3600, 1)},
            "looks_24h": within(24), "looks_72h": len(passes),
            "radar_only_looks": sum(p["optical"] != "clear" for p in passes),
            "passes": passes[:40],
            "priority": score(e, now),
        })
    out.sort(key=lambda x: -x["priority"]["value"])
    return {"status": "ready", "updated_at": now.isoformat(), "window_start": now.isoformat(), "window_hours": hours,
            "feeds": feeds + [{"name": "NOAA cloud forecast", "ok": cloud.ready(), "count": 0,
                               "error": cloud.status()["error"] or (None if cloud.ready() else "still downloading")}],
            "cloud": cloud.status(), "kp": osint.fetch_kp(), "events": out}


def snapshot() -> dict:
    with _lock:
        return _state


def find_event(event_id: str) -> dict | None:
    return next((e for e in snapshot()["events"] if e["id"] == event_id), None)


_alerted: set[str] = set()


def _alert_new(events: list[dict]) -> None:
    """One Slack message per event that crosses the priority threshold. The first board after start-up is not announced."""
    first_run = not _alerted
    for e in events:
        if e["priority"]["value"] < settings.slack_alert_min_priority or e["id"] in _alerted:
            continue
        _alerted.add(e["id"])
        if first_run:
            continue
        f = e["first_look"]
        connectors.slack(
            f":rotating_light: *{e['title']}* ({e['severity_label']}), priority {e['priority']['value']}",
            fields=[("First radar look", f"in {f['hours_from_now']} h, {f['satellite']}" if f else "none in 72 h"),
                    ("Optical blind", f"{e['optical']['blind_fraction']:.0%} of next 72 h"),
                    ("People within 100 km", f"{e['exposure']['population']:,}"),
                    ("Sources", ", ".join(s["name"] for s in e["sources"]))],
            link=f"{settings.public_url}/?event={e['id']}")
    if first_run and not _alerted:
        _alerted.add("")  # remember that the first run happened even when nothing qualified


def refresh_once() -> None:
    global _state
    try:
        fresh = build()
        _alert_new(fresh["events"])
        with _lock:
            _state = fresh
    except Exception as exc:
        log.exception("Watch board refresh failed")
        with _lock:
            if _state["status"] == "loading":
                _state = {**_state, "status": "error", "error": str(exc)[:200]}


def start_background() -> None:
    def loop():
        while True:
            had_cloud = cloud.ready()
            refresh_once()
            if cloud.stale():
                cloud.load()  # about a minute on first start; whole-world files, no location in the request
            # Rebuild straight away once the forecast arrives, otherwise wait for the next cycle.
            time.sleep(1 if cloud.ready() and not had_cloud else settings.intel_refresh_minutes * 60)

    threading.Thread(target=loop, name="watch-board", daemon=True).start()
