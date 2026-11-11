"""Hash-chained audit log.

Every event stores the SHA-256 of its own content plus the hash of the previous
event. Editing or deleting any row breaks the chain from that point on, and
`verify_chain` reports where.
"""

import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .models import AuditEvent

GENESIS = "0" * 64
_LOCK_KEY = 7_041_776


def compute_hash(prev_hash: str, ts: str, actor: str, action: str, request_id: str | None, payload: dict) -> str:
    body = json.dumps(
        {"ts": ts, "actor": actor, "action": action, "request_id": request_id, "payload": payload},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256((prev_hash + body).encode()).hexdigest()


def record(db: Session, actor: str, action: str, request_id: str | None = None, payload: dict | None = None) -> AuditEvent:
    """Append one event. Call inside the caller's transaction."""
    payload = payload or {}
    # One writer at a time, so two requests cannot both chain from the same row.
    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_KEY})
    last = db.execute(select(AuditEvent).order_by(AuditEvent.id.desc()).limit(1)).scalar_one_or_none()
    prev_hash = last.hash if last else GENESIS
    ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    event = AuditEvent(
        ts=ts,
        actor=actor,
        action=action,
        request_id=request_id,
        payload=payload,
        prev_hash=prev_hash,
        hash=compute_hash(prev_hash, ts, actor, action, request_id, payload),
    )
    db.add(event)
    db.flush()
    return event


def verify_events(events: list) -> dict:
    """Check a list of events (oldest first). Works on any objects with the event fields."""
    prev = GENESIS
    for e in events:
        expected = compute_hash(prev, e.ts, e.actor, e.action, e.request_id, e.payload)
        if e.prev_hash != prev or e.hash != expected:
            return {"ok": False, "checked": len(events), "broken_at_id": e.id}
        prev = e.hash
    return {"ok": True, "checked": len(events), "broken_at_id": None}


def verify_chain(db: Session) -> dict:
    events = db.execute(select(AuditEvent).order_by(AuditEvent.id)).scalars().all()
    return verify_events(list(events))
