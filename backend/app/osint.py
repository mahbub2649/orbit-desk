"""Public data feeds: world events and space weather.

Every fetcher is independent and returns (items, error). One feed failing never
breaks the others. No API keys are needed for any of these sources.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)
UA = {"User-Agent": "orbit-desk-prototype"}

GDACS_TYPES = {"EQ": "earthquake", "TC": "cyclone", "FL": "flood", "VO": "volcano", "WF": "wildfire"}
EONET_TYPES = {"wildfires": "wildfire", "severeStorms": "cyclone", "volcanoes": "volcano", "floods": "flood"}
# How close in space (km) and time (hours) two reports must be to count as the same event.
MERGE_RULES = {"earthquake": (150, 6), "cyclone": (600, 240), "flood": (400, 240), "volcano": (100, 720), "wildfire": (80, 240)}


def _get_json(url: str, timeout: float = 20):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _clip(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _parse_time(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def fetch_usgs() -> list[dict]:
    data = _get_json("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson")
    out = []
    for f in data["features"]:
        p, (lon, lat, depth) = f["properties"], f["geometry"]["coordinates"]
        mag = p.get("mag") or 0
        if mag < 5.5 and (p.get("sig") or 0) < 500:
            continue
        out.append({
            "type": "earthquake", "title": f"M {mag:.1f} earthquake, {p.get('place') or 'unknown location'}",
            "lat": lat, "lon": lon, "time": datetime.fromtimestamp(p["time"] / 1000, timezone.utc),
            "severity": _clip((mag - 5) / 2.5, 0.15, 1.0), "severity_label": f"M {mag:.1f}",
            "detail": f"Depth {depth:.0f} km" + (", tsunami flag" if p.get("tsunami") else ""),
            "sources": [{"name": "USGS", "url": p.get("url")}],
        })
    return out


def fetch_gdacs() -> list[dict]:
    now = datetime.now(timezone.utc)
    query = urllib.parse.urlencode({
        "alertlevel": "Green;Orange;Red", "eventlist": "EQ;TC;FL;VO;WF",
        "fromDate": (now - timedelta(days=12)).date().isoformat(), "toDate": (now + timedelta(days=1)).date().isoformat(),
    }, safe=";")
    data = _get_json(f"https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?{query}", timeout=30)
    out = []
    for f in data.get("features", []):
        p = f["properties"]
        kind = GDACS_TYPES.get(p.get("eventtype"))
        if not kind or f["geometry"]["type"] != "Point":
            continue
        ended = _parse_time(p["todate"]) if p.get("todate") else now
        if str(p.get("iscurrent")).lower() != "true" and now - ended > timedelta(days=4):
            continue
        level = p.get("alertlevel", "Orange")
        if level == "Green" and kind != "flood":  # minor alerts are kept for floods only
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        sev = (p.get("severitydata") or {}).get("severitytext") or ""
        out.append({
            "type": kind, "title": (p.get("name") or p.get("description") or kind.title()).strip(),
            "lat": lat, "lon": lon, "time": _parse_time(p["fromdate"]),
            "severity": {"Red": 1.0, "Orange": 0.7}.get(level, 0.4), "severity_label": f"{level} alert",
            "detail": sev.strip(), "sources": [{"name": "GDACS", "url": (p.get("url") or {}).get("report")}],
        })
    return out


def fetch_eonet() -> list[dict]:
    data = _get_json("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=20&limit=120", timeout=30)
    out = []
    for e in data.get("events", []):
        kind = EONET_TYPES.get(e["categories"][0]["id"])
        geo = e["geometry"][-1] if e.get("geometry") else None
        if not kind or not geo or geo.get("type") != "Point":
            continue
        if "prescribed" in e["title"].lower():  # planned burns are not incidents
            continue
        lon, lat = geo["coordinates"][:2]
        value, unit = geo.get("magnitudeValue"), geo.get("magnitudeUnit") or ""
        if kind == "cyclone" and value:
            severity, label = _clip(value / 120, 0.2, 1.0), f"{value:.0f} {unit}"
        elif kind == "wildfire" and value:
            severity, label = _clip(math.log10(max(value, 10)) / 6, 0.15, 0.8), f"{value:,.0f} {unit}"
        else:
            severity, label = (0.6, "Active") if kind == "volcano" else (0.3, "Active")
        src = (e.get("sources") or [{}])[0]
        out.append({
            "type": kind, "title": e["title"], "lat": lat, "lon": lon, "time": _parse_time(geo["date"]),
            "severity": severity, "severity_label": label, "detail": "",
            "sources": [{"name": f"NASA EONET ({src.get('id', 'source')})", "url": src.get("url")}],
        })
    return out


FEEDS = {"USGS earthquakes": fetch_usgs, "GDACS disaster alerts": fetch_gdacs, "NASA EONET": fetch_eonet}


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(a))


def fuse(events: list[dict]) -> list[dict]:
    """Merge reports of the same event from different feeds. The most severe report wins."""
    kept: list[dict] = []
    for e in sorted(events, key=lambda x: -x["severity"]):
        km, hrs = MERGE_RULES[e["type"]]
        twin = next((k for k in kept if k["type"] == e["type"]
                     and distance_km(k["lat"], k["lon"], e["lat"], e["lon"]) <= km
                     and abs((k["time"] - e["time"]).total_seconds()) <= hrs * 3600), None)
        if twin:
            names = {s["name"] for s in twin["sources"]}
            twin["sources"] += [s for s in e["sources"] if s["name"] not in names]
            if e["detail"] and e["detail"] not in twin["detail"]:
                twin["detail"] = "; ".join(x for x in (twin["detail"], e["detail"]) if x)
        else:
            kept.append({**e, "sources": list(e["sources"])})
    for e in kept:
        key = f"{e['type']}|{e['lat']:.1f}|{e['lon']:.1f}|{e['time'].date().isoformat()}"
        e["id"] = f"{e['type'][:2]}-{hashlib.sha1(key.encode()).hexdigest()[:8]}"
    return kept


def collect_events() -> tuple[list[dict], list[dict]]:
    """Return (fused events, per-feed status)."""
    raw, status = [], []
    for name, fn in FEEDS.items():
        try:
            items = fn()
            raw += items
            status.append({"name": name, "ok": True, "count": len(items), "error": None})
        except Exception as exc:
            log.warning("Feed %s failed: %s", name, exc)
            status.append({"name": name, "ok": False, "count": 0, "error": f"{type(exc).__name__}: {str(exc)[:120]}"})
    return fuse(raw), status


def fetch_kp() -> dict | None:
    """Latest planetary K index (geomagnetic activity). High values degrade orbit predictions."""
    try:
        rows = _get_json("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json")
        last = rows[-1]
        kp = float(last["Kp"] if isinstance(last, dict) else last[1])
        when = last["time_tag"] if isinstance(last, dict) else last[0]
        level = "storm" if kp >= 5 else "active" if kp >= 4 else "quiet"
        return {"value": round(kp, 1), "time": when, "level": level}
    except Exception as exc:
        log.warning("Space weather feed failed: %s", exc)
        return None
