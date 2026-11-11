"""Remember which watch-board event an order came from, so the same event is not ordered twice."""
revision = "0002"
down_revision = "0001"

import sqlalchemy as sa
from alembic import op


def upgrade() -> None:
    op.add_column("tasking_requests", sa.Column("origin_event", sa.String(32), nullable=True), schema="orbitdesk")
    op.create_index("ix_tasking_requests_origin_event", "tasking_requests", ["origin_event"], schema="orbitdesk")


def downgrade() -> None:
    op.drop_index("ix_tasking_requests_origin_event", "tasking_requests", schema="orbitdesk")
    op.drop_column("tasking_requests", "origin_event", schema="orbitdesk")
