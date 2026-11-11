"""Worldwide latency map: how long until the first radar look, for every cell of a grid.

Same access model as `orbits.passes_from` (a look counts at closest approach when the
incidence angle is inside the limits), evaluated for thousands of cell centres at once.
Nothing here depends on events or orders, and nothing leaves the app.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from datetime import datetime, timezone

import numpy as np

from . import orbits
from .config import settings

log = logging.getLogger(__name__)

CELL_DEG = 4.0
HORIZON_HOURS = 24.0
REFRESH_SECONDS = 600
_CHUNK = 1024  # grid cells per block, to keep temporary arrays small


def grid(cell_deg: float = CELL_DEG) -> tuple[np.ndarray, np.ndarray]:
    """Cell-centre latitudes (south to north) and longitudes (west to east)."""
    lats = np.arange(-90 + cell_deg / 2, 90, cell_deg)
    lons = np.arange(-180 + cell_deg / 2, 180, cell_deg)
    return lats, lons


def latency(eph: dict, cell_deg: float = CELL_DEG, min_inc: float | None = None, max_inc: float | None = None) -> dict:
    """Hours to the first look and number of looks in the window, per cell (row-major, south to north)."""
    min_inc = settings.min_incidence_deg if min_inc is None else min_inc
    max_inc = settings.max_incidence_deg if max_inc is None else max_inc
    lats, lons = grid(cell_deg)
    lat_g, lon_g = np.meshgrid(lats, lons, indexing="ij")
    lat_f, lon_f = lat_g.ravel(), lon_g.ravel()
    n_cells = lat_f.size

    targets = np.stack([orbits.geodetic_to_ecef(a, o) for a, o in zip(lat_f, lon_f)]).astype(np.float32)
    phi, lam = np.deg2rad(lat_f), np.deg2rad(lon_f)
    ups = np.stack([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)], axis=1).astype(np.float32)
    t_up = np.einsum("ij,ij->i", targets, ups)
    t_sq = np.einsum("ij,ij->i", targets, targets)

    step_s = eph["step_s"]
    r_all = eph["r"].astype(np.float32)
    floor = math.sin(math.radians(90 - max_inc - 4))  # same margin as passes_from; refined below
    first = np.full(n_cells, np.inf)
    looks = np.zeros(n_cells, dtype=np.int32)

    for i in range(r_all.shape[0]):
        if eph["err"][i].any():
            continue  # a satellite whose orbit data fails to propagate is left out
        r = r_all[i]
        r_sq = np.einsum("ij,ij->i", r, r)[:, None]
        for lo in range(0, n_cells, _CHUNK):
            hi = min(lo + _CHUNK, n_cells)
            rng = np.sqrt(r_sq - 2 * (r @ targets[lo:hi].T) + t_sq[lo:hi])
            s = (r @ ups[lo:hi].T - t_up[lo:hi]) / rng  # sine of the satellite's elevation seen from each cell
            peak = (s[1:-1] > s[:-2]) & (s[1:-1] >= s[2:]) & (s[1:-1] > floor)
            k, g = np.nonzero(peak)
            if not k.size:
                continue
            k = k + 1
            y0, y1, y2 = (np.arcsin(np.clip(s[k + d, g], -1, 1)).astype(np.float64) for d in (-1, 0, 1))
            denom = y0 - 2 * y1 + y2
            delta = np.where(denom != 0, 0.5 * (y0 - y2) / np.where(denom != 0, denom, 1), 0.0)
            inc = 90 - np.rad2deg(y1 - 0.25 * (y0 - y2) * delta)
            ok = (inc >= min_inc) & (inc <= max_inc)
            hours = (k[ok] + delta[ok]) * step_s / 3600
            cells = g[ok] + lo
            np.minimum.at(first, cells, hours)
            np.add.at(looks, cells, 1)

    return {"lats": lats, "lons": lons, "hours": first.reshape(lat_g.shape), "looks": looks.reshape(lat_g.shape)}


def _weighted_quantile(values: np.ndarray, weights: np.ndarray, q: float) -> float:
    order = np.argsort(values)
    cum = np.cumsum(weights[order])
    return float(values[order][np.searchsorted(cum, q * cum[-1])])


def summarize(result: dict, horizon_hours: float) -> dict:
    """Area-weighted statistics. A cell near the pole covers less ground than one at the equator."""
    lats, lons, hours, looks = result["lats"], result["lons"], result["hours"], result["looks"]
    w = np.repeat(np.cos(np.deg2rad(lats))[:, None], lons.size, axis=1)
    seen = np.isfinite(hours)
    total = float(w.sum())
    share = lambda limit: round(float(w[seen & (hours <= limit)].sum()) / total, 3)  # noqa: E731
    capped = np.where(seen, hours, horizon_hours)
    worst = np.unravel_index(int(np.argmax(capped)), hours.shape)
    by_lat = []
    for j, lat in enumerate(lats):
        row = capped[j]
        by_lat.append({"lat": float(lat), "median_hours": round(float(np.median(row)), 2), "max_hours": round(float(row.max()), 2),
                       "looks": round(float(looks[j].mean()), 1)})
    return {
        "median_hours": round(_weighted_quantile(capped.ravel(), w.ravel(), 0.5), 2),
        "p90_hours": round(_weighted_quantile(capped.ravel(), w.ravel(), 0.9), 2),
        "within_1h": share(1), "within_3h": share(3), "within_6h": share(6),
        "never_share": round(float(w[~seen].sum()) / total, 3),
        "worst": {"lat": float(lats[worst[0]]), "lon": float(lons[worst[1]]),
                  "hours": None if not seen[worst] else round(float(hours[worst]), 2)},
        "mean_looks": round(float((looks * w).sum()) / total, 1),
        "by_lat": by_lat,
    }


def build(now: datetime | None = None) -> dict:
    now = (now or datetime.now(timezone.utc)).replace(microsecond=0)
    data = orbits.load_satellites()
    t0 = time.perf_counter()
    eph = orbits.ephemeris(data["satellites"], now, HORIZON_HOURS)
    result = latency(eph)
    hours = result["hours"]
    return {
        "status": "ready",
        "computed_at": now.isoformat(),
        "compute_seconds": round(time.perf_counter() - t0, 2),
        "horizon_hours": HORIZON_HOURS,
        "cell_deg": CELL_DEG,
        "rows": int(hours.shape[0]),
        "cols": int(hours.shape[1]),
        "satellites": len(data["satellites"]),
        "access_model": {"min_incidence_deg": settings.min_incidence_deg, "max_incidence_deg": settings.max_incidence_deg},
        # Row-major, south to north, west to east. null = no look inside the window.
        "hours": [None if not math.isfinite(h) else round(float(h), 2) for h in hours.ravel()],
        "looks": [int(n) for n in result["looks"].ravel()],
        "stats": summarize(result, HORIZON_HOURS),
    }


_state: dict = {"status": "computing"}
_lock = threading.Lock()
_started = False


def snapshot() -> dict:
    with _lock:
        return _state


def lookup(lat: float, lon: float) -> dict | None:
    """The cell that contains a point, from the current map."""
    snap = snapshot()
    if snap.get("status") != "ready":
        return None
    c = snap["cell_deg"]
    row = min(snap["rows"] - 1, max(0, int((lat + 90) // c)))
    col = int(((lon + 180) % 360) // c) % snap["cols"]
    i = row * snap["cols"] + col
    return {"hours_to_first_look": snap["hours"][i], "looks_in_window": snap["looks"][i], "window_hours": snap["horizon_hours"],
            "cell_centre": {"lat": -90 + (row + 0.5) * c, "lon": -180 + (col + 0.5) * c}, "computed_at": snap["computed_at"]}


def refresh_once() -> None:
    global _state
    try:
        fresh = build()
        with _lock:
            _state = fresh
    except Exception as exc:
        log.exception("Latency map refresh failed")
        with _lock:
            if _state.get("status") != "ready":
                _state = {"status": "error", "error": str(exc)[:200]}


def start_background() -> None:
    global _started
    if _started:
        return
    _started = True

    def loop():
        while True:
            refresh_once()
            time.sleep(REFRESH_SECONDS)

    threading.Thread(target=loop, name="latency-map", daemon=True).start()
