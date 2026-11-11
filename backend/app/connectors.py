"""Writes to outside systems after approval, and Slack notifications.

Jira is real when JIRA_* settings are present, simulated otherwise. Salesforce
is simulated until its integration is built. Every write is guarded by an
idempotency key, so retrying an order never creates a second record. A failed
write is recorded and can be retried; it never blocks the approval itself.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import threading
import urllib.error
import urllib.request

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import settings
from .models import IntegrationRecord, TaskingRequest

log = logging.getLogger(__name__)


class IntegrationError(Exception):
    pass


def _http(method: str, url: str, body: dict, headers: dict, timeout: float = 15) -> tuple[int, str]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method=method,
                                 headers={"Content-Type": "application/json", "Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        raise IntegrationError(f"HTTP {exc.code}: {exc.read().decode()[:300]}") from exc
    except urllib.error.URLError as exc:
        raise IntegrationError(f"cannot reach {url.split('/')[2]}: {exc.reason}") from exc


# ---------- Jira ----------

def jira_enabled() -> bool:
    return all([settings.jira_base_url, settings.jira_email, settings.jira_api_token, settings.jira_project_key])


def _adf(paragraphs: list[str]) -> dict:
    """Jira Cloud wants descriptions in its own document format."""
    return {"type": "doc", "version": 1,
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": p}]} for p in paragraphs if p]}


def _jira_lines(req: TaskingRequest) -> list[str]:
    o, f = req.order, req.feasibility or {}
    lines = [
        o.get("summary") or "",
        f"Area: {o.get('latitude')}, {o.get('longitude')} ({req.country or 'open sea'}), radius {o.get('radius_km')} km.",
        f"Imaging: {o.get('imaging_mode')} mode, {'every ' + format(o['revisit_hours'], 'g') + ' h' if o.get('revisit_hours') else 'once'}, {o.get('priority')} priority.",
    ]
    if f:
        lines.append(f"Feasibility: {f.get('verdict')}. {f.get('reason')}")
        for p in f.get("plan", [])[:8]:
            lines.append(f"Planned: {p['time']} {p['satellite']} at {p['incidence_deg']} deg, looking {p['look_side']}.")
    lines.append(f"Orbit Desk request {req.id}. Approved by: " + ", ".join(f"{a.role} {a.actor}" for a in req.approvals if a.decision == "approve") + ".")
    return lines


def _jira_payload(req: TaskingRequest) -> dict:
    o = req.order
    return {"fields": {
        "project": {"key": settings.jira_project_key},
        "issuetype": {"name": settings.jira_issue_type},
        "summary": f"Schedule {o.get('imaging_mode')} collection: {o.get('location_name') or 'unspecified area'}"[:250],
        "description": _adf(_jira_lines(req)),
        "labels": ["orbit-desk", f"orbitdesk-{req.id}"],
    }}


def create_jira_issue(req: TaskingRequest) -> tuple[str, dict]:
    payload = _jira_payload(req)
    token = base64.b64encode(f"{settings.jira_email}:{settings.jira_api_token}".encode()).decode()
    _, body = _http("POST", settings.jira_base_url.rstrip("/") + "/rest/api/3/issue", payload, {"Authorization": f"Basic {token}"})
    key = json.loads(body)["key"]
    return key, {**payload, "_mode": "live", "_url": f"{settings.jira_base_url.rstrip('/')}/browse/{key}"}


# ---------- Simulated systems ----------

def _salesforce_payload(req: TaskingRequest) -> dict:
    o = req.order
    return {
        "sobject": "Opportunity",
        "Name": f"SAR tasking: {o.get('location_name') or 'unspecified'} ({o.get('customer') or 'unknown customer'})",
        "StageName": "Proposal",
        "Type": "Recurring" if o.get("cadence") == "recurring" else "One-off",
        "Description": o.get("summary"),
        "OrbitDesk_Request__c": req.id,
        "_mode": "simulated",
    }


def _simulated_jira(db: Session, req: TaskingRequest) -> tuple[str, dict]:
    count = db.execute(select(func.count()).select_from(IntegrationRecord).where(IntegrationRecord.system == "jira")).scalar_one()
    return f"TASK-{101 + count}", {**_jira_payload(req), "_mode": "simulated"}


def sync(db: Session, req: TaskingRequest) -> tuple[list[IntegrationRecord], list[dict]]:
    """Create the CRM deal and the ops ticket once each. Safe to call again.

    Returns (records created now, failures). Systems that already have a record are skipped.
    """
    created, failed = [], []
    for system in ("salesforce", "jira"):
        key = f"{system}:{req.id}"
        if db.execute(select(IntegrationRecord).where(IntegrationRecord.idempotency_key == key)).scalar_one_or_none():
            continue
        try:
            if system == "salesforce":
                external_id, payload = "006" + hashlib.sha1(key.encode()).hexdigest()[:15].upper(), _salesforce_payload(req)
            elif jira_enabled():
                external_id, payload = create_jira_issue(req)
            else:
                external_id, payload = _simulated_jira(db, req)
        except (IntegrationError, KeyError, ValueError) as exc:
            log.warning("%s write failed for %s: %s", system, req.id, exc)
            failed.append({"system": system, "error": str(exc)[:300]})
            continue
        record = IntegrationRecord(request_id=req.id, system=system, external_id=external_id, idempotency_key=key, payload=payload)
        db.add(record)
        db.flush()
        created.append(record)
    return created, failed


def status() -> dict:
    return {"jira": "live" if jira_enabled() else "simulated", "salesforce": "simulated",
            "slack": "live" if settings.slack_webhook_url else "off"}


# ---------- Slack ----------

def slack(text: str, fields: list[tuple[str, str]] | None = None, link: str | None = None) -> None:
    """Post to the Slack channel behind the incoming webhook. Never blocks or fails the caller."""
    if not settings.slack_webhook_url:
        return
    blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": text}}]
    if fields:
        blocks.append({"type": "section", "fields": [{"type": "mrkdwn", "text": f"*{k}*\n{v}"} for k, v in fields[:10]]})
    if link:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"<{link}|Open in Orbit Desk>"}]})

    def send():
        try:
            _http("POST", settings.slack_webhook_url, {"text": text, "blocks": blocks}, {})
        except IntegrationError as exc:
            log.warning("Slack notification failed: %s", exc)

    threading.Thread(target=send, daemon=True).start()
