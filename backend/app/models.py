from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import SCHEMA, Base


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid4().hex[:12]


class TaskingRequest(Base):
    __tablename__ = "tasking_requests"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[str] = mapped_column(String(12), primary_key=True, default=new_id)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    created_by: Mapped[str] = mapped_column(String(64))
    raw_text: Mapped[str] = mapped_column(Text)
    parser: Mapped[str] = mapped_column(String(32))
    parser_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    country: Mapped[str | None] = mapped_column(String(128), nullable=True)
    origin_event: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    order: Mapped[dict] = mapped_column(JSONB)
    feasibility: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    policy: Mapped[dict] = mapped_column(JSONB)

    approvals: Mapped[list["Approval"]] = relationship(
        back_populates="request", order_by="Approval.ts", cascade="all, delete-orphan"
    )
    integrations: Mapped[list["IntegrationRecord"]] = relationship(
        back_populates="request", order_by="IntegrationRecord.ts", cascade="all, delete-orphan"
    )


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.tasking_requests.id"), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    role: Mapped[str] = mapped_column(String(32))
    actor: Mapped[str] = mapped_column(String(64))
    decision: Mapped[str] = mapped_column(String(16))
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    request: Mapped[TaskingRequest] = relationship(back_populates="approvals")


class IntegrationRecord(Base):
    """A write to an outside system. The idempotency key makes retries safe."""

    __tablename__ = "integration_records"
    __table_args__ = (UniqueConstraint("idempotency_key"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.tasking_requests.id"), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    system: Mapped[str] = mapped_column(String(32))
    external_id: Mapped[str] = mapped_column(String(64))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    payload: Mapped[dict] = mapped_column(JSONB)

    request: Mapped[TaskingRequest] = relationship(back_populates="integrations")


class AuditEvent(Base):
    """Append-only log. Each row stores the hash of the row before it."""

    __tablename__ = "audit_events"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[str] = mapped_column(String(40))
    actor: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(64))
    request_id: Mapped[str | None] = mapped_column(String(12), nullable=True, index=True)
    payload: Mapped[dict] = mapped_column(JSONB)
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))
