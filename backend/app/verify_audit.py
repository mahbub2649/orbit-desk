"""Verify the hash-chained audit log once and exit. Run on a schedule by EventBridge Scheduler.

    python -m app.verify_audit

Prints one Splunk HEC JSON line with the result and exits 1 when the chain is broken,
so both a CloudWatch metric filter and the task's exit code can raise an alarm.
"""

import socket
import sys
import time

from . import audit
from .config import settings
from .db import SessionLocal


def main() -> int:
    with SessionLocal() as db:
        result = audit.verify_chain(db)
    audit.emit_hec({
        "time": round(time.time(), 3),
        "host": socket.gethostname(),
        "source": settings.hec_source,
        "sourcetype": "orbitdesk:audit_check",
        "event": {"action": "audit_chain_verify", **result},
    })
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
