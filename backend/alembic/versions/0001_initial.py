"""Initial schema: requests, approvals, integration records, audit log."""
revision = "0001"
down_revision = None

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

S = "orbitdesk"


def upgrade() -> None:
    op.execute(f"CREATE SCHEMA IF NOT EXISTS {S}")
    op.create_table(
        "tasking_requests",
        sa.Column("id", sa.String(12), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("raw_text", sa.Text, nullable=False),
        sa.Column("parser", sa.String(32), nullable=False),
        sa.Column("parser_note", sa.Text),
        sa.Column("status", sa.String(32), nullable=False, index=True),
        sa.Column("country", sa.String(128)),
        sa.Column("order", JSONB, nullable=False),
        sa.Column("feasibility", JSONB),
        sa.Column("policy", JSONB, nullable=False),
        schema=S,
    )
    op.create_table(
        "approvals",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("request_id", sa.String(12), sa.ForeignKey(f"{S}.tasking_requests.id"), nullable=False, index=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("actor", sa.String(64), nullable=False),
        sa.Column("decision", sa.String(16), nullable=False),
        sa.Column("comment", sa.Text),
        schema=S,
    )
    op.create_table(
        "integration_records",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("request_id", sa.String(12), sa.ForeignKey(f"{S}.tasking_requests.id"), nullable=False, index=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("system", sa.String(32), nullable=False),
        sa.Column("external_id", sa.String(64), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False, unique=True),
        sa.Column("payload", JSONB, nullable=False),
        schema=S,
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("ts", sa.String(40), nullable=False),
        sa.Column("actor", sa.String(64), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("request_id", sa.String(12), index=True),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column("prev_hash", sa.String(64), nullable=False),
        sa.Column("hash", sa.String(64), nullable=False),
        schema=S,
    )


def downgrade() -> None:
    for table in ("audit_events", "integration_records", "approvals", "tasking_requests"):
        op.drop_table(table, schema=S)
