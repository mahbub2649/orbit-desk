from typing import Literal

from pydantic import BaseModel


class ParsedOrder(BaseModel):
    """A customer request turned into a structured tasking order."""

    customer: str | None = None
    location_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    radius_km: float = 5.0
    imaging_mode: Literal["spot", "strip", "scan"] = "spot"
    cadence: Literal["once", "recurring"] = "once"
    revisit_hours: float | None = None
    start_date: str | None = None
    end_date: str | None = None
    priority: Literal["routine", "priority", "urgent"] = "routine"
    purpose: str = ""
    summary: str = ""
    open_questions: list[str] = []


class CreateRequest(BaseModel):
    text: str


class AskTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AskRequest(BaseModel):
    question: str
    history: list[AskTurn] = []
    context: str | None = None


class DraftRequest(BaseModel):
    audience: Literal["insurer", "government", "humanitarian", "maritime"] = "insurer"


class Decision(BaseModel):
    decision: Literal["approve", "reject"]
    comment: str | None = None
