"""Approval rules.

Rules are fixed code, evaluated from the order's coordinates and fields. The AI
parser has no say in them. The restricted list is an example for the demo, not
legal or export-control advice.
"""

from __future__ import annotations

import json
from functools import lru_cache

from .config import DATA_DIR
from .schemas import ParsedOrder

RESTRICTED_COUNTRIES = {"North Korea", "Russia", "Belarus", "Iran", "Myanmar"}
LARGE_AREA_KM = 50

ROLE_LABELS = {"manager": "Sales manager", "compliance": "Compliance officer"}


@lru_cache
def _countries() -> list[dict]:
    path = DATA_DIR / "countries.geojson"
    if not path.exists():
        return []
    return json.loads(path.read_text())["features"]


def _in_ring(lon: float, lat: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _in_polygon(lon: float, lat: float, polygon: list) -> bool:
    return _in_ring(lon, lat, polygon[0]) and not any(_in_ring(lon, lat, hole) for hole in polygon[1:])


def country_at(lat: float, lon: float) -> str | None:
    for feature in _countries():
        geom = feature["geometry"]
        if not geom:
            continue
        polygons = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        if any(_in_polygon(lon, lat, p) for p in polygons):
            return feature["properties"].get("name")
    return None


def evaluate(order: ParsedOrder, country: str | None) -> dict:
    """Return which approvals are required and why."""
    required = ["manager"]
    rules = [{"id": "R1", "level": "info", "text": "Every tasking order needs sales manager approval."}]

    if country in RESTRICTED_COUNTRIES:
        required.append("compliance")
        rules.append({
            "id": "R2",
            "level": "block",
            "text": f"The area is in {country}, which is on the restricted list. Compliance approval is required.",
        })
    if order.priority == "urgent":
        rules.append({"id": "R3", "level": "warn", "text": "Urgent order: confirm operations capacity before approving."})
    if order.radius_km > LARGE_AREA_KM:
        rules.append({"id": "R4", "level": "warn", "text": f"Large area (radius over {LARGE_AREA_KM} km): may need several collections."})
    if order.open_questions:
        rules.append({"id": "R5", "level": "warn", "text": "There are open questions to confirm with the customer."})

    return {"required_roles": required, "rules": rules}
