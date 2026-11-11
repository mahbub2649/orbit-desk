from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from . import agent, audit, briefs, cloud, connectors, coverage, geo, orbits, policy, watch
from .config import settings
from .db import SessionLocal, get_db
from .models import Approval, AuditEvent, TaskingRequest
from .parser import has_llm_credentials, parse_request
from .schemas import AskRequest, CreateRequest, Decision, DraftRequest, ParsedOrder

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("orbitdesk")

# Demo sign-in: the dashboard picks a person and sends their key in a header.
# A real deployment would take the identity from the company's single sign-on.
USERS = {
    "aino": {"key": "aino", "name": "Aino Virtanen", "role": "sales", "title": "Account executive"},
    "mikko": {"key": "mikko", "name": "Mikko Laine", "role": "manager", "title": "Sales manager"},
    "sara": {"key": "sara", "name": "Sara Niemi", "role": "compliance", "title": "Compliance officer"},
}

SEED_REQUESTS = [
    ("aino", "Customer: Nordhavn Logistics wants to monitor the Port of Rotterdam weekly for 3 months to track container yard activity."),
    ("aino", "Customer: Baltic Re needs urgent flood extent imaging over Dhaka, every 2 days for 2 weeks."),
    ("aino", "Customer: Polar Research Institute asks for a one-off wide-area scan of sea ice near Svalbard."),
]


def current_user(x_demo_user: str = Header(default="aino")) -> dict:
    user = USERS.get(x_demo_user)
    if not user:
        raise HTTPException(401, "Unknown demo user")
    return user


def _window_start(order: ParsedOrder) -> datetime:
    """Use the requested start date if it is soon; otherwise analyse a representative week from now."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    if order.start_date:
        try:
            start = datetime.fromisoformat(order.start_date).replace(tzinfo=timezone.utc)
            if now < start <= now + timedelta(days=7):
                return start
        except ValueError:
            pass
    return now


COMPETITORS = [("iceye", "ICEYE"), ("capella", "Capella Space"), ("umbra", "Umbra")]


def compare_constellations(lat: float, lon: float, start: datetime) -> list[dict]:
    """Opportunities per radar constellation for the same place, same window, same simple model."""
    rows = []
    for group, label in COMPETITORS:
        try:
            sats = orbits.load_satellites(group)["satellites"]
            passes = orbits.find_passes(sats, lat, lon, start)
            a = orbits.assess(passes, start, settings.horizon_hours, None)
            rows.append({"name": label, "satellites": len(sats), "opportunities": len(passes),
                         "per_day": a["per_day"], "max_gap_hours": a["max_gap_hours"]})
        except Exception:
            log.exception("Comparison failed for %s", group)
    return rows


OPEN_STATUSES = ("pending_approval", "approved", "synced")


def booked_collections(db: Session) -> list[dict]:
    """Planned collections of every open order, so a new plan does not reuse a busy satellite."""
    rows = db.execute(select(TaskingRequest).where(TaskingRequest.status.in_(OPEN_STATUSES))).scalars().all()
    return [{"norad_id": p["norad_id"], "time": p["time"], "order": r.order.get("location_name") or r.id}
            for r in rows for p in (r.feasibility or {}).get("plan", [])]


def build_request(db: Session, text: str, user: dict, preset: ParsedOrder | None = None, origin: dict | None = None) -> TaskingRequest:
    if preset:
        order, parser_name, note = preset, "event feed", None
    else:
        order, parser_name, note = parse_request(text)
    country = None
    feasibility = None
    if order.latitude is not None:
        country = policy.country_at(order.latitude, order.longitude)
        sats = orbits.load_satellites()["satellites"]
        start = _window_start(order)
        passes = orbits.find_passes(sats, order.latitude, order.longitude, start)
        watch.tag_passes(passes, order.latitude, order.longitude)
        feasibility = orbits.assess(passes, start, settings.horizon_hours, order.revisit_hours, booked=booked_collections(db))
        feasibility["passes"] = passes
        feasibility["optical"] = watch.optical_profile(order.latitude, order.longitude, start, int(settings.horizon_hours))
        feasibility["exposure"] = geo.exposure(order.latitude, order.longitude)
        feasibility["radar_only"] = {k: sum(p["optical"] == k for p in passes) for k in ("night", "cloud", "clear")}
        feasibility["comparison"] = compare_constellations(order.latitude, order.longitude, start)
        feasibility["assumptions"] = {
            "min_incidence_deg": settings.min_incidence_deg,
            "max_incidence_deg": settings.max_incidence_deg,
            "satellites_considered": len(sats),
        }
    decision = policy.evaluate(order, country)
    status = "pending_approval" if order.latitude is not None else "needs_clarification"

    req = TaskingRequest(
        created_by=user["key"], raw_text=text, parser=parser_name, parser_note=note, status=status,
        country=country, order=order.model_dump(), feasibility=feasibility, policy=decision,
        origin_event=(origin or {}).get("event_id"),
    )
    db.add(req)
    db.flush()
    audit.record(db, user["key"], "request.created", req.id, {"text": text, **({"from_event": origin} if origin else {})})
    audit.record(db, "system", "order.parsed", req.id, {"parser": parser_name, "order": order.model_dump()})
    audit.record(db, "system", "policy.evaluated", req.id, {
        "country": country, "required_roles": decision["required_roles"], "rules": [r["id"] for r in decision["rules"]],
    })
    if feasibility:
        audit.record(db, "system", "feasibility.computed", req.id, {
            "verdict": feasibility["verdict"], "opportunities": feasibility["opportunities"],
            "conflicts_avoided": len(feasibility["conflicts_avoided"]),
        })
    return req


def serialize(req: TaskingRequest, full: bool = True) -> dict:
    approved_roles = {a.role for a in req.approvals if a.decision == "approve"}
    outstanding = [r for r in req.policy["required_roles"] if r not in approved_roles]
    feas = req.feasibility
    if feas and not full:
        feas = {k: v for k, v in feas.items() if k not in ("passes", "optical", "comparison")}
    return {
        "id": req.id,
        "created_at": req.created_at.isoformat(),
        "created_by": USERS.get(req.created_by, {"name": req.created_by})["name"],
        "created_by_key": req.created_by,
        "raw_text": req.raw_text,
        "parser": req.parser,
        "parser_note": req.parser_note,
        "status": req.status,
        "country": req.country,
        "order": req.order,
        "feasibility": feas,
        "policy": req.policy,
        "outstanding_roles": outstanding if req.status == "pending_approval" else [],
        "approvals": [
            {"role": a.role, "actor": USERS.get(a.actor, {"name": a.actor})["name"], "decision": a.decision,
             "comment": a.comment, "ts": a.ts.isoformat()}
            for a in req.approvals
        ],
        "integrations": [
            {"system": i.system, "external_id": i.external_id, "ts": i.ts.isoformat(), "payload": i.payload,
             "mock": i.payload.get("_mode") != "live", "url": i.payload.get("_url")}
            for i in req.integrations
        ],
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        orbits.load_satellites()
        coverage.start_background()  # orbit geometry only; runs even with the public feeds turned off
        if settings.intel_enabled:
            watch.start_background()
        if settings.seed_demo_data:
            with SessionLocal() as db:
                if db.execute(select(func.count()).select_from(TaskingRequest)).scalar_one() == 0:
                    for user_key, text in SEED_REQUESTS:
                        build_request(db, text, USERS[user_key])
                    db.commit()
    except Exception:
        log.exception("Startup preparation failed")
    yield


app = FastAPI(title="Orbit Desk", lifespan=lifespan)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/meta")
def meta(db: Session = Depends(get_db)):
    sats = orbits.load_satellites()
    counts = dict(db.execute(select(TaskingRequest.status, func.count()).group_by(TaskingRequest.status)).all())
    return {
        "users": list(USERS.values()),
        "ai_parser": has_llm_credentials(),
        "agent_available": agent.available(),
        "intel_enabled": settings.intel_enabled,
        "cloud": cloud.status(),
        "integrations": connectors.status(),
        "llm_model": settings.llm_model,
        "satellites": len(sats["satellites"]),
        "orbit_data": {k: sats[k] for k in ("source", "median_epoch", "age_hours")},
        "status_counts": counts,
        "restricted_countries": sorted(policy.RESTRICTED_COUNTRIES),
        "access_model": {"min_incidence_deg": settings.min_incidence_deg, "max_incidence_deg": settings.max_incidence_deg,
                         "horizon_hours": settings.horizon_hours},
    }


@app.get("/api/satellites")
def satellites():
    return orbits.load_satellites()


@app.get("/api/requests")
def list_requests(db: Session = Depends(get_db)):
    rows = db.execute(
        select(TaskingRequest).options(selectinload(TaskingRequest.approvals), selectinload(TaskingRequest.integrations))
        .order_by(TaskingRequest.created_at.desc()).limit(100)
    ).scalars().all()
    return [serialize(r, full=False) for r in rows]


def _get(db: Session, request_id: str) -> TaskingRequest:
    req = db.get(TaskingRequest, request_id)
    if not req:
        raise HTTPException(404, "Request not found")
    return req


@app.get("/api/requests/{request_id}")
def get_request(request_id: str, db: Session = Depends(get_db)):
    return serialize(_get(db, request_id))


@app.post("/api/requests", status_code=201)
def create_request(body: CreateRequest, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "The request text is empty")
    if len(text) > 4000:
        raise HTTPException(422, "The request text is too long (4000 characters at most)")
    req = build_request(db, text, user)
    db.commit()
    _notify_new(req)
    return serialize(req)


def _notify_new(req: TaskingRequest) -> None:
    if req.status != "pending_approval":
        return
    f = req.feasibility or {}
    connectors.slack(
        f":satellite: *New tasking order needs approval:* {req.order.get('location_name')}",
        fields=[("Feasibility", f"{f.get('verdict', 'n/a')}: {f.get('opportunities', 0)} looks in 7 days"),
                ("Waiting for", ", ".join(policy.ROLE_LABELS[r] for r in req.policy["required_roles"])),
                ("Priority", req.order.get("priority", "")), ("Country", req.country or "open sea")],
        link=f"{settings.public_url}/?order={req.id}")


@app.get("/api/intel/watch")
def watch_board():
    return watch.snapshot()


@app.get("/api/coverage")
def coverage_map():
    """Hours to the first radar look for every cell of a world grid, rebuilt every 10 minutes."""
    return coverage.snapshot()


@app.get("/api/coverage/at")
def coverage_at(lat: float, lon: float):
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(422, "Latitude must be between -90 and 90, longitude between -180 and 180.")
    cell = coverage.lookup(lat, lon)
    if cell is None:
        raise HTTPException(503, "The latency map is still being computed. Try again in a few seconds.")
    return cell


def _markdown(name: str, body: str) -> PlainTextResponse:
    return PlainTextResponse(body, media_type="text/markdown; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}.md"'})


@app.get("/api/intel/events/{event_id}/brief")
def event_brief(event_id: str):
    event = watch.find_event(event_id)
    if not event:
        raise HTTPException(404, "This event is no longer on the watch board")
    return _markdown(f"brief-{event_id}", briefs.event_brief(event))


@app.get("/api/requests/{request_id}/brief")
def request_brief(request_id: str, db: Session = Depends(get_db)):
    return _markdown(f"order-{request_id}", briefs.order_brief(serialize(_get(db, request_id))))


@app.post("/api/requests/from-event/{event_id}", status_code=201)
def create_from_event(event_id: str, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    event = watch.find_event(event_id)
    if not event:
        raise HTTPException(404, "This event is no longer on the watch board")
    existing = db.execute(select(TaskingRequest).where(
        TaskingRequest.origin_event == event_id, TaskingRequest.status.in_(OPEN_STATUSES))).scalars().first()
    if existing:  # one open order per event; open the existing one instead of making a copy
        return {**serialize(existing), "already_existed": True}
    wide = event["type"] in ("cyclone", "flood", "wildfire")
    order = ParsedOrder(
        location_name=event["title"][:80], latitude=event["lat"], longitude=event["lon"],
        radius_km=50 if wide else 20, imaging_mode="scan" if wide else "strip",
        cadence="recurring", revisit_hours=24, priority="urgent",
        purpose=f"Damage and extent mapping after a {event['type']}",
        summary=f"Daily {'scan' if wide else 'strip'} imaging of the {event['type']} area, starting now.",
        open_questions=["No customer yet: this is a proactive lead from the watch board."],
    )
    text = f"Proactive lead from the watch board: {event['title']} ({event['severity_label']}). Sources: " + ", ".join(s["name"] for s in event["sources"]) + "."
    req = build_request(db, text, user, preset=order, origin={"event_id": event_id, "priority": event["priority"]["value"]})
    db.commit()
    _notify_new(req)
    return serialize(req)


@app.post("/api/requests/{request_id}/decision")
def decide(request_id: str, body: Decision, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    req = db.get(TaskingRequest, request_id, with_for_update=True)
    if not req:
        raise HTTPException(404, "Request not found")

    def deny(reason: str):
        audit.record(db, user["key"], "decision.denied", req.id, {"reason": reason, "attempted": body.decision})
        db.commit()
        raise HTTPException(403, reason)

    if req.status != "pending_approval":
        raise HTTPException(409, f"This request is not waiting for approval (status: {req.status})")
    approved_roles = {a.role for a in req.approvals if a.decision == "approve"}
    outstanding = [r for r in req.policy["required_roles"] if r not in approved_roles]
    if user["role"] not in outstanding:
        deny(f"Your role ({user['title'].lower()}) cannot decide this request. Waiting for: "
             + ", ".join(policy.ROLE_LABELS[r].lower() for r in outstanding) + ".")
    if user["key"] == req.created_by:
        deny("You cannot approve a request you created.")

    db.add(Approval(request_id=req.id, role=user["role"], actor=user["key"], decision=body.decision, comment=body.comment))
    db.flush()
    audit.record(db, user["key"], f"decision.{body.decision}", req.id, {"role": user["role"], "comment": body.comment})

    if body.decision == "reject":
        req.status = "rejected"
    elif len(outstanding) == 1:  # this was the last approval needed
        req.status = "approved"
        db.refresh(req)
        _sync(db, req)
    db.commit()
    db.refresh(req)
    _notify_decision(req, user, body.decision)
    return serialize(req)


def _sync(db: Session, req: TaskingRequest) -> None:
    created, failed = connectors.sync(db, req)
    for rec in created:
        audit.record(db, "system", "integration.write", req.id,
                     {"system": rec.system, "external_id": rec.external_id, "mock": rec.payload.get("_mode") != "live"})
    for f in failed:
        audit.record(db, "system", "integration.failed", req.id, f)
    db.flush()
    db.refresh(req)
    req.status = "synced" if len(req.integrations) >= 2 else "approved"


def _notify_decision(req: TaskingRequest, user: dict, decision: str) -> None:
    place = req.order.get("location_name") or "an order"
    link = f"{settings.public_url}/?order={req.id}"
    if decision == "reject":
        connectors.slack(f":x: *Rejected:* {place}, by {user['name']}.", link=link)
    elif req.status in ("synced", "approved"):
        tickets = ", ".join(f"{i.system} {i.external_id}" for i in req.integrations) or "none yet"
        connectors.slack(f":white_check_mark: *Approved:* {place}. Records: {tickets}.", link=link)
    else:
        connectors.slack(f":hourglass: *{user['title']} approved* {place}. Still waiting for another approval.", link=link)


@app.post("/api/requests/{request_id}/sync")
def retry_sync(request_id: str, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """Retry writes to outside systems that failed after approval."""
    req = db.get(TaskingRequest, request_id, with_for_update=True)
    if not req:
        raise HTTPException(404, "Request not found")
    if req.status != "approved":
        raise HTTPException(409, "Only approved orders with a failed write can be retried")
    _sync(db, req)
    audit.record(db, user["key"], "integration.retry", req.id, {"status": req.status})
    db.commit()
    db.refresh(req)
    return serialize(req)


@app.post("/api/agent/ask")
def agent_ask(body: AskRequest, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    question = body.question.strip()
    if not question or len(question) > 1500:
        raise HTTPException(422, "Ask a question of up to 1500 characters")
    try:
        result = agent.ask(question, [t.model_dump() for t in body.history], (body.context or "")[:300] or None, db)
    except agent.AgentUnavailable as exc:
        raise HTTPException(503, str(exc))
    except Exception as exc:
        log.exception("Analyst failed")
        raise HTTPException(502, f"The analyst failed: {type(exc).__name__}")
    audit.record(db, user["key"], "agent.ask", None, {
        "question": question[:500], "tools": [c["tool"] for c in result["tool_calls"]],
        "stopped": result["stopped"], "model": result["model"]})
    db.commit()
    return result


@app.post("/api/intel/events/{event_id}/draft")
def event_draft(event_id: str, body: DraftRequest, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    event = watch.find_event(event_id)
    if not event:
        raise HTTPException(404, "This event is no longer on the watch board")
    try:
        draft = agent.draft_outreach(event, body.audience)
    except agent.AgentUnavailable as exc:
        raise HTTPException(503, str(exc))
    except Exception as exc:
        log.exception("Draft failed")
        raise HTTPException(502, f"The draft failed: {type(exc).__name__}")
    audit.record(db, user["key"], "agent.draft", None, {"event_id": event_id, "audience": body.audience, "model": draft["model"]})
    db.commit()
    return draft


@app.get("/api/audit")
def audit_log(request_id: str | None = None, limit: int = 200, db: Session = Depends(get_db)):
    q = select(AuditEvent).order_by(AuditEvent.id.desc()).limit(min(limit, 500))
    if request_id:
        q = q.where(AuditEvent.request_id == request_id)
    return [
        {"id": e.id, "ts": e.ts, "actor": USERS.get(e.actor, {"name": e.actor})["name"], "action": e.action,
         "request_id": e.request_id, "payload": e.payload, "hash": e.hash, "prev_hash": e.prev_hash}
        for e in db.execute(q).scalars().all()
    ]


@app.get("/api/audit/verify")
def audit_verify(db: Session = Depends(get_db)):
    return audit.verify_chain(db)


# Serve the built dashboard when it is present (the Docker image includes it).
if settings.static_dir.exists():
    app.mount("/assets", StaticFiles(directory=settings.static_dir / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        candidate = settings.static_dir / path
        if path and candidate.is_file() and settings.static_dir in candidate.resolve().parents:
            return FileResponse(candidate)
        return FileResponse(settings.static_dir / "index.html")
