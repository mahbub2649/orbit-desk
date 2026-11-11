from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL

DATA_DIR = Path(__file__).parent / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://orbitdesk:orbitdesk@db:5432/orbitdesk"
    # On AWS the connection comes in parts: ECS injects DB_USERNAME and DB_PASSWORD from the
    # Secrets Manager secret that RDS manages, so no password is ever written into a URL by hand.
    db_host: str = ""
    db_port: int = 5432
    db_name: str = "orbitdesk"
    db_username: str = ""
    db_password: str = ""
    db_sslmode: str = "require"
    # IAM database authentication: no password at all. Each new connection gets a 15-minute token
    # signed with the task role's credentials (Aurora express clusters accept only this).
    db_iam_auth: bool = False
    aws_region: str = "eu-north-1"

    # Audit events are also written to stdout as Splunk HTTP Event Collector JSON, so a log
    # shipper (CloudWatch Logs here) can forward them to a SIEM without reformatting.
    audit_hec_stdout: bool = True
    hec_source: str = "orbit-desk"
    anthropic_api_key: str = ""
    llm_model: str = "claude-opus-5-5"

    # Where refreshed orbit data is cached. The bundled seed file is the fallback.
    tle_cache_dir: Path = Path("/tmp/orbitdesk")
    tle_source_url: str = "https://celestrak.org/NORAD/elements/gp.php?NAME={name}&FORMAT=tle"
    tle_max_age_hours: float = 6.0
    tle_refresh: bool = True

    # Simplified access model (assumptions, not vendor specifications).
    min_incidence_deg: float = 15.0
    max_incidence_deg: float = 45.0
    horizon_hours: float = 168.0
    step_seconds: int = 20

    # Public data feeds (events, weather, space weather). Set to false to run fully offline.
    intel_enabled: bool = True
    intel_refresh_minutes: float = 10.0
    watch_horizon_hours: float = 72.0
    cloud_blind_pct: float = 70.0

    # Integrations. Each one switches from simulated to real when its settings are present.
    jira_base_url: str = ""
    jira_email: str = ""
    jira_api_token: str = ""
    jira_project_key: str = ""
    jira_issue_type: str = "Task"
    slack_webhook_url: str = ""
    slack_alert_min_priority: int = 30
    public_url: str = "http://localhost:8000"

    static_dir: Path = Path("/app/static")
    seed_demo_data: bool = True


    @property
    def sqlalchemy_url(self) -> str | URL:
        """The database URL. Built from parts when DB_HOST is set; URL.create escapes any
        special characters in a generated password."""
        if not self.db_host:
            return self.database_url
        return URL.create("postgresql+psycopg", username=self.db_username,
                          password=None if self.db_iam_auth else self.db_password,
                          host=self.db_host, port=self.db_port, database=self.db_name,
                          query={"sslmode": self.db_sslmode})


settings = Settings()
