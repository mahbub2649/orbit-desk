from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

DATA_DIR = Path(__file__).parent / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://orbitdesk:orbitdesk@db:5432/orbitdesk"
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


settings = Settings()
