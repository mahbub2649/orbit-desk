from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

SCHEMA = "orbitdesk"


def iam_token() -> str:
    """A 15-minute IAM authentication token for the database user (signed locally, no network call)."""
    import boto3  # only needed on AWS

    return boto3.client("rds", region_name=settings.aws_region).generate_db_auth_token(
        DBHostname=settings.db_host, Port=settings.db_port, DBUsername=settings.db_username, Region=settings.aws_region)


def make_engine() -> Engine:
    eng = create_engine(settings.sqlalchemy_url, pool_pre_ping=True, pool_recycle=600)
    if settings.db_iam_auth:
        @event.listens_for(eng, "do_connect")
        def _token(dialect, conn_rec, cargs, cparams):  # noqa: ANN001
            cparams["password"] = iam_token()  # fresh token for every new connection
    return eng


engine = make_engine()
SessionLocal = sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    with SessionLocal() as session:
        yield session
