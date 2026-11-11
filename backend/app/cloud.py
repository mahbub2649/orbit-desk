"""Global cloud-cover forecast from NOAA's GFS weather model.

The whole-world grid (1 degree) is downloaded as files and looked up locally.
No location is ever sent to anyone: every installation requests the same files.
"""

from __future__ import annotations

import logging
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

from .config import settings

log = logging.getLogger(__name__)
UA = {"User-Agent": "orbit-desk-prototype"}
URL = ("https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl?dir=%2Fgfs.{day}%2F{cycle:02d}%2Fatmos"
       "&file=gfs.t{cycle:02d}z.pgrb2.1p00.f{step:03d}&var_TCDC=on&lev_entire_atmosphere=on")
# Every 3 hours for the first 3 days, then every 6 hours out to 7.5 days.
STEPS = list(range(0, 73, 3)) + list(range(78, 181, 6))

_state: dict = {"status": "loading", "cycle": None, "times": None, "grid": None, "loaded_at": 0.0, "error": None}
_lock = threading.Lock()


def _fetch(day: str, cycle: int, step: int) -> bytes:
    req = urllib.request.Request(URL.format(day=day, cycle=cycle, step=step), headers=UA)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def _decode(raw: bytes) -> np.ndarray:
    """First message of the file: total cloud cover in percent, 181 x 360, north to south, from 0 degrees east."""
    import eccodes

    gid = eccodes.codes_new_from_message(raw)
    try:
        values = eccodes.codes_get_values(gid)
        nj, ni = eccodes.codes_get(gid, "Nj"), eccodes.codes_get(gid, "Ni")
    finally:
        eccodes.codes_release(gid)
    return np.clip(values.reshape(nj, ni), 0, 100).astype(np.uint8)


def _latest_cycle() -> datetime:
    """The newest model run that is published. Runs start every 6 hours and appear a few hours later."""
    t = datetime.now(timezone.utc) - timedelta(hours=4)
    t = t.replace(hour=t.hour // 6 * 6, minute=0, second=0, microsecond=0)
    for _ in range(5):
        try:
            _fetch(t.strftime("%Y%m%d"), t.hour, STEPS[-1])
            return t
        except urllib.error.HTTPError:
            t -= timedelta(hours=6)
    raise RuntimeError("no recent forecast run is available")


def load() -> None:
    global _state
    cache = settings.tle_cache_dir / "gfs_cloud.npz"
    try:
        if cache.exists() and time.time() - cache.stat().st_mtime < 6 * 3600:
            data = np.load(cache, allow_pickle=False)
            cycle = datetime.fromisoformat(str(data["cycle"]))
            grid = data["grid"]
        else:
            cycle = _latest_cycle()
            day, frames = cycle.strftime("%Y%m%d"), []
            for step in STEPS:
                frames.append(_decode(_fetch(day, cycle.hour, step)))
                time.sleep(0.25)  # be gentle with a public server
            grid = np.stack(frames)
            settings.tle_cache_dir.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(cache, grid=grid, cycle=cycle.isoformat())
        times = np.array([(cycle + timedelta(hours=s)).timestamp() for s in STEPS])
        with _lock:
            _state = {"status": "ready", "cycle": cycle.isoformat(), "times": times, "grid": grid, "loaded_at": time.time(), "error": None}
        log.info("Cloud forecast ready: run %s, %d time steps", cycle.isoformat(), len(STEPS))
    except Exception as exc:
        log.exception("Cloud forecast load failed")
        with _lock:
            if _state["grid"] is None:
                _state = {**_state, "status": "error", "error": f"{type(exc).__name__}: {str(exc)[:160]}"}


def status() -> dict:
    s = _state
    return {"status": s["status"], "cycle": s["cycle"], "error": s["error"], "source": "NOAA GFS, 1 degree grid, whole-world download"}


def ready() -> bool:
    return _state["grid"] is not None


def stale() -> bool:
    return _state["grid"] is None or time.time() - _state["loaded_at"] > 6 * 3600


def at(lat: float, lon: float, when: datetime) -> int | None:
    """Cloud cover in percent at a place and time, or None when the forecast does not cover it."""
    s = _state
    if s["grid"] is None:
        return None
    ts = when.timestamp()
    k = int(np.argmin(np.abs(s["times"] - ts)))
    if abs(s["times"][k] - ts) > 3.5 * 3600:
        return None
    i = min(180, max(0, round(90 - lat)))
    j = round(lon % 360) % 360
    return int(s["grid"][k, i, j])


def install(grid: np.ndarray, cycle: datetime) -> None:
    """Set the forecast directly (used by tests)."""
    global _state
    times = np.array([(cycle + timedelta(hours=s)).timestamp() for s in STEPS[: len(grid)]])
    _state = {"status": "ready", "cycle": cycle.isoformat(), "times": times, "grid": grid, "loaded_at": time.time(), "error": None}
