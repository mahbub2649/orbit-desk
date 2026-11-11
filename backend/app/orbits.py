"""Orbit data and imaging-opportunity prediction.

Uses public two-line element sets (TLEs) and the SGP4 propagator.

Access model (a simplification, stated in the README): a radar satellite images
to the side, so an opportunity exists at the moment of closest approach when the
incidence angle at the target lies between a minimum and a maximum. Every
catalogued satellite is treated as available; real scheduling also depends on
satellite health, power, downlink and existing orders.
"""

from __future__ import annotations

import logging
import math
import statistics
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
from sgp4.api import Satrec, SatrecArray, jday

from .config import DATA_DIR, settings

log = logging.getLogger(__name__)

WGS84_A = 6378.137
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)

SEED_FILE = DATA_DIR / "iceye_tle_seed.txt"


# ---------- TLE loading ----------

def parse_tle(text: str) -> list[dict]:
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    sats = []
    i = 0
    while i + 2 < len(lines):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if l1.startswith("1 ") and l2.startswith("2 "):
            sats.append({"name": name.strip(), "norad_id": int(l1[2:7]), "line1": l1, "line2": l2})
            i += 3
        else:
            i += 1
    return sats


def _epoch(sat: dict) -> datetime:
    rec = Satrec.twoline2rv(sat["line1"], sat["line2"])
    jd = rec.jdsatepoch + rec.jdsatepochF
    return datetime(2000, 1, 1, 12, tzinfo=timezone.utc) + timedelta(days=jd - 2451545.0)


_cache: dict = {}


def _refresh_from_network(group: str) -> str | None:
    cache_file = settings.tle_cache_dir / f"{group}_tle.txt"
    max_age = settings.tle_max_age_hours * 3600
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < max_age:
        return cache_file.read_text()
    if not settings.tle_refresh:
        return cache_file.read_text() if cache_file.exists() else None
    try:
        url = settings.tle_source_url.format(name=group.upper())
        req = urllib.request.Request(url, headers={"User-Agent": "orbit-desk-prototype"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            text = resp.read().decode()
        if len(parse_tle(text)) < 3:
            raise ValueError("unexpected response from orbit data source")
        settings.tle_cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(text)
        return text
    except Exception as exc:  # network is optional; the seed file keeps the app working
        log.warning("Orbit data refresh failed for %s, using older data: %s", group, exc)
        return cache_file.read_text() if cache_file.exists() else None


def load_satellites(group: str = "iceye") -> dict:
    """Return {"satellites": [...], "source": str, "median_epoch": iso, "age_hours": float}."""
    hit = _cache.get(group)
    if hit and time.time() - hit[0] < 900:
        return hit[1]
    text = _refresh_from_network(group)
    source = "celestrak (live cache)"
    if text is None:
        text = (DATA_DIR / f"{group}_tle_seed.txt").read_text()
        source = "bundled seed file"
    sats = parse_tle(text)
    epochs = sorted(_epoch(s) for s in sats)
    median_epoch = epochs[len(epochs) // 2]
    result = {
        "satellites": sats,
        "source": source,
        "median_epoch": median_epoch.isoformat(),
        "age_hours": round((datetime.now(timezone.utc) - median_epoch).total_seconds() / 3600, 1),
    }
    _cache[group] = (time.time(), result)
    return result


# ---------- Geometry ----------

def gmst_rad(jd_ut1: np.ndarray) -> np.ndarray:
    """Greenwich mean sidereal time (IAU 1982 model)."""
    t = (jd_ut1 - 2451545.0) / 36525.0
    sec = 67310.54841 + (876600.0 * 3600 + 8640184.812866) * t + 0.093104 * t**2 - 6.2e-6 * t**3
    return np.deg2rad((sec % 86400.0) / 240.0)


def geodetic_to_ecef(lat_deg: float, lon_deg: float, h_km: float = 0.0) -> np.ndarray:
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(lat) ** 2)
    return np.array([
        (n + h_km) * math.cos(lat) * math.cos(lon),
        (n + h_km) * math.cos(lat) * math.sin(lon),
        (n * (1 - WGS84_E2) + h_km) * math.sin(lat),
    ])


def _up_vector(lat_deg: float, lon_deg: float) -> np.ndarray:
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    return np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])


def sun_elevation_deg(when, lat: float, lon: float):
    """Sun elevation at a place (degrees). `when` is a datetime or a list of datetimes. Good to about a degree."""
    single = isinstance(when, datetime)
    times = [when] if single else list(when)
    doy = np.array([t.timetuple().tm_yday + t.hour / 24 for t in times])
    hours = np.array([t.hour + t.minute / 60 + t.second / 3600 for t in times])
    decl = np.deg2rad(-23.44 * np.cos(2 * np.pi * (doy + 10) / 365))
    hour_angle = np.deg2rad((hours - 12) * 15 + lon)
    phi = math.radians(lat)
    el = np.rad2deg(np.arcsin(np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(hour_angle)))
    return float(el[0]) if single else el


def ephemeris(sats: list[dict], start: datetime, hours: float, step_s: int | None = None) -> dict:
    """Positions of every satellite over a time window, in the Earth-fixed frame.

    Computed once and reused for any number of targets.
    """
    step_s = step_s or settings.step_seconds
    start = start.astimezone(timezone.utc)
    n = int(hours * 3600 / step_s) + 1
    jd0, fr0 = jday(start.year, start.month, start.day, start.hour, start.minute, start.second + start.microsecond / 1e6)
    offsets = np.arange(n) * step_s
    fr = fr0 + offsets / 86400.0
    jd = np.full(n, jd0)

    recs = [Satrec.twoline2rv(s["line1"], s["line2"]) for s in sats]
    err, r, v = SatrecArray(recs).sgp4(jd, fr)  # (nsat, n, 3) in the TEME frame, km and km/s

    theta = gmst_rad(jd + fr)
    c, s_ = np.cos(theta), np.sin(theta)

    def to_ecef(a: np.ndarray) -> np.ndarray:
        out = np.empty_like(a)
        out[..., 0] = c * a[..., 0] + s_ * a[..., 1]
        out[..., 1] = -s_ * a[..., 0] + c * a[..., 1]
        out[..., 2] = a[..., 2]
        return out

    return {"sats": sats, "start": start, "hours": hours, "step_s": step_s, "offsets": offsets,
            "r": to_ecef(r), "v": to_ecef(v), "err": err}


def passes_from(eph: dict, lat: float, lon: float, min_inc: float | None = None, max_inc: float | None = None) -> list[dict]:
    """Imaging opportunities over one target, sorted by time."""
    min_inc = settings.min_incidence_deg if min_inc is None else min_inc
    max_inc = settings.max_incidence_deg if max_inc is None else max_inc
    sats, start, step_s, offsets, r_e, v_e, err = (eph[k] for k in ("sats", "start", "step_s", "offsets", "r", "v", "err"))
    target = geodetic_to_ecef(lat, lon)
    up = _up_vector(lat, lon)

    rho = r_e - target
    rng = np.linalg.norm(rho, axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        el = np.arcsin(np.clip((rho @ up) / rng, -1, 1))  # elevation of the satellite seen from the target
    el = np.where(err == 0, el, -np.pi / 2)

    floor = math.radians(90 - max_inc - 4)  # small margin; refined below
    peak = (el[:, 1:-1] > el[:, :-2]) & (el[:, 1:-1] >= el[:, 2:]) & (el[:, 1:-1] > floor)

    passes = []
    for i, k in zip(*np.nonzero(peak)):
        k = k + 1
        y0, y1, y2 = el[i, k - 1], el[i, k], el[i, k + 1]
        denom = y0 - 2 * y1 + y2
        delta = 0.5 * (y0 - y2) / denom if denom != 0 else 0.0
        el_peak = y1 - 0.25 * (y0 - y2) * delta
        inc = 90 - math.degrees(el_peak)
        if not (min_inc <= inc <= max_inc):
            continue
        when = start + timedelta(seconds=float(offsets[k] + delta * step_s))
        h = np.cross(r_e[i, k], v_e[i, k])  # points to the left of the flight direction
        side = "left" if float(np.dot(target - r_e[i, k], h)) > 0 else "right"
        local_hours = (when.hour + when.minute / 60 + lon / 15) % 24
        passes.append({
            "satellite": sats[i]["name"],
            "norad_id": sats[i]["norad_id"],
            "time": when.isoformat(timespec="seconds"),
            "incidence_deg": round(inc, 1),
            "look_side": side,
            "direction": "ascending" if v_e[i, k, 2] > 0 else "descending",
            "range_km": round(float(rng[i, k])),
            "local_time": f"{int(local_hours):02d}:{int(local_hours % 1 * 60):02d}",
        })
    passes.sort(key=lambda p: p["time"])
    return passes


def find_passes(sats: list[dict], lat: float, lon: float, start: datetime, hours: float | None = None,
                step_s: int | None = None, min_inc: float | None = None, max_inc: float | None = None) -> list[dict]:
    return passes_from(ephemeris(sats, start, hours or settings.horizon_hours, step_s), lat, lon, min_inc, max_inc)


# ---------- Feasibility ----------

def assess(passes: list[dict], start: datetime, hours: float, revisit_hours: float | None, booked: list[dict] | None = None) -> dict:
    """Turn a list of opportunities into a verdict and a suggested collection plan."""
    times = [datetime.fromisoformat(p["time"]) for p in passes]
    gaps = [(b - a).total_seconds() / 3600 for a, b in zip(times, times[1:])]
    end = start + timedelta(hours=hours)
    # Include the wait before the first pass and after the last one.
    edge_gaps = gaps[:]
    if times:
        edge_gaps += [(times[0] - start).total_seconds() / 3600, (end - times[-1]).total_seconds() / 3600]

    summary = {
        "window_start": start.isoformat(timespec="seconds"),
        "window_hours": hours,
        "opportunities": len(passes),
        "satellites_used": len({p["norad_id"] for p in passes}),
        "per_day": round(len(passes) / (hours / 24), 1),
        "first_opportunity": passes[0]["time"] if passes else None,
        "median_gap_hours": round(statistics.median(gaps), 1) if gaps else None,
        "max_gap_hours": round(max(edge_gaps), 1) if edge_gaps else None,
        "required_revisit_hours": revisit_hours,
    }

    if not passes:
        verdict, reason = "not_feasible", "No imaging opportunities in the window with this access model."
    elif revisit_hours is None:
        wait = (times[0] - start).total_seconds() / 3600
        verdict, reason = "feasible", f"First opportunity {wait:.1f} hours after the window opens."
    elif summary["max_gap_hours"] <= revisit_hours:
        verdict = "feasible"
        reason = f"Longest gap between opportunities is {summary['max_gap_hours']} h, within the required {revisit_hours:g} h."
    elif summary["median_gap_hours"] is not None and summary["median_gap_hours"] <= revisit_hours:
        verdict = "tight"
        reason = (
            f"Typical gap is {summary['median_gap_hours']} h but the longest is {summary['max_gap_hours']} h, "
            f"above the required {revisit_hours:g} h."
        )
    else:
        verdict = "not_feasible"
        reason = f"Longest gap is {summary['max_gap_hours']} h, above the required {revisit_hours:g} h."

    plan, avoided = _plan(passes, times, start, hours, revisit_hours, booked or [])
    summary.update(verdict=verdict, reason=reason, plan=plan, conflicts_avoided=avoided)
    return summary


CONFLICT_MINUTES = 10


def _clash(p: dict, booked: list[dict]) -> dict | None:
    """A satellite cannot serve two orders within a few minutes of each other."""
    t = datetime.fromisoformat(p["time"])
    for b in booked:
        if b["norad_id"] == p["norad_id"] and abs((datetime.fromisoformat(b["time"]) - t).total_seconds()) < CONFLICT_MINUTES * 60:
            return b
    return None


def _plan(passes: list[dict], times: list[datetime], start: datetime, hours: float, revisit_hours: float | None,
          booked: list[dict]) -> tuple[list[dict], list[dict]]:
    """One collection per revisit interval, preferring mid-range incidence angles and skipping booked satellites."""
    if not passes:
        return [], []
    mid = (settings.min_incidence_deg + settings.max_incidence_deg) / 2
    slots = 1 if revisit_hours is None else min(60, max(1, math.ceil(hours / revisit_hours)))
    width = hours if revisit_hours is None else revisit_hours
    plan, avoided = [], []
    for slot in range(slots):
        lo = start + timedelta(hours=slot * width)
        hi = lo + timedelta(hours=width)
        candidates = [p for p, t in zip(passes, times) if lo <= t < hi]
        candidates.sort(key=(lambda p: p["time"]) if revisit_hours is None else (lambda p: abs(p["incidence_deg"] - mid)))
        for i, p in enumerate(candidates):
            clash = _clash(p, booked)
            if clash is None:
                plan.append(p)
                break
            if i == 0:
                avoided.append({"satellite": p["satellite"], "time": p["time"], "booked_by": clash.get("order", "another order")})
    return plan, avoided
