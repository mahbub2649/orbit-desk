"""Offline city database (GeoNames, cities above 15,000 people, CC BY 4.0).

Used for two things without any network call: how many people live near a
place, and turning a city name into coordinates.
"""

from __future__ import annotations

import gzip
from functools import lru_cache

import numpy as np

from .config import DATA_DIR


@lru_cache
def _cities() -> dict:
    names, ascii_names, countries, lat, lon, pop = [], [], [], [], [], []
    with gzip.open(DATA_DIR / "cities.tsv.gz", "rt", encoding="utf-8") as f:
        for line in f:
            n, a, cc, la, lo, p = line.rstrip("\n").split("\t")
            names.append(n); ascii_names.append(a); countries.append(cc)
            lat.append(float(la)); lon.append(float(lo)); pop.append(int(p or 0))
    index: dict[str, int] = {}
    order = sorted(range(len(names)), key=lambda i: pop[i])  # larger cities overwrite smaller namesakes
    for i in order:
        index[names[i].lower()] = i
        index[ascii_names[i].lower()] = i
    return {"name": names, "country": countries, "lat": np.radians(lat), "lon": np.radians(lon),
            "lat_deg": lat, "lon_deg": lon, "pop": np.array(pop), "index": index}


def _distances_km(lat: float, lon: float) -> np.ndarray:
    c = _cities()
    p1, l1 = np.radians(lat), np.radians(lon)
    a = np.sin((c["lat"] - p1) / 2) ** 2 + np.cos(p1) * np.cos(c["lat"]) * np.sin((c["lon"] - l1) / 2) ** 2
    return 2 * 6371 * np.arcsin(np.sqrt(a))


def exposure(lat: float, lon: float, radius_km: float = 100) -> dict:
    """People living in listed cities within the radius, and the nearest sizeable city."""
    c, d = _cities(), _distances_km(lat, lon)
    near = np.nonzero(d <= radius_km)[0]
    top = sorted(near, key=lambda i: -c["pop"][i])[:3]
    k = int(np.argmin(d))
    return {
        "radius_km": radius_km,
        "population": int(c["pop"][near].sum()),
        "cities": [{"name": c["name"][i], "country": c["country"][i], "population": int(c["pop"][i]), "km": round(float(d[i]))} for i in top],
        "nearest": {"name": c["name"][k], "country": c["country"][k], "population": int(c["pop"][k]), "km": round(float(d[k]))},
    }


def geocode(name: str, min_population: int = 0) -> dict | None:
    c = _cities()
    i = c["index"].get(name.strip().lower())
    if i is None or c["pop"][i] < min_population:
        return None
    return {"name": c["name"][i], "country": c["country"][i], "lat": c["lat_deg"][i], "lon": c["lon_deg"][i], "population": int(c["pop"][i])}


def find_city_in_text(text: str) -> dict | None:
    """Largest city whose name appears in the text as capitalised words (up to three words long)."""
    import re

    words = re.findall(r"[A-Za-zÀ-ÿ'\-]+", text)
    best = None
    for size in (3, 2, 1):
        for i in range(len(words) - size + 1):
            chunk = words[i:i + size]
            if not all(w[0].isupper() for w in chunk):
                continue
            hit = geocode(" ".join(chunk), min_population=100_000 if size == 1 else 15_000)
            if hit and (best is None or hit["population"] > best["population"]):
                best = hit
        if best:
            return best
    return None
