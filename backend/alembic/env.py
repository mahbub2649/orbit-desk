from alembic import context
from sqlalchemy import create_engine

from app import models  # noqa: F401  (registers the tables)
from app.config import settings
from app.db import Base

target_metadata = Base.metadata


def run_migrations_online() -> None:
    engine = create_engine(settings.database_url)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, include_schemas=True)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
