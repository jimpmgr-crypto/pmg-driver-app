#!/usr/bin/env python3
"""Read-only live health check for PMG driver routes and worker compatibility."""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


APP = "https://pmg-driver-app.pages.dev"
WORKER = "https://pmg-driver-sync.jimpmgr.workers.dev"
DRIVERS = ("john", "andrew", "neil", "ian", "richard", "paul")
STATE = Path("/Users/bill/.openclaw/workspace/OPENCORE/state/pmg-driver-app-runtime-health")
PROJECT_INDEX = Path("/Users/bill/.openclaw/workspace/projects/pmg-driver-app/index.html")
LOCAL_APP_VERSION = Path("/Users/bill/.openclaw/workspace/projects/pmg-driver-app/app-version.json")
REQUIRED_RUNTIME_PATCH_ID = "20260827-driver-load-attachment-v1"


def expected_worker_build(live_version: dict[str, Any], local_version: dict[str, Any]) -> tuple[str, str]:
    """Use reviewed local metadata for a compatible worker-only release."""
    live_expected = str(live_version.get("expectedWorkerBuildId") or "")
    same_frontend = str(local_version.get("buildId") or "") == str(live_version.get("buildId") or "")
    same_contract = str(local_version.get("driverApiContract") or "") == str(live_version.get("driverApiContract") or "")
    local_expected = str(local_version.get("expectedWorkerBuildId") or "")
    if same_frontend and same_contract and local_expected:
        return local_expected, "local-reviewed-split-worker-release"
    return live_expected, "live-app-version"


def fetch(url: str, headers: dict[str, str] | None = None) -> tuple[bytes, str, int]:
    request = urllib.request.Request(
        url,
        headers={
            "Cache-Control": "no-cache",
            "User-Agent": "PMGDriverRuntimeCheck/1.0",
            **(headers or {}),
        },
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        return response.read(), response.geturl(), response.status


def check() -> dict[str, Any]:
    checked_at = datetime.now(timezone.utc).isoformat()
    cache_buster = time.time_ns()
    errors: list[str] = []
    warnings: list[str] = []
    routes: dict[str, Any] = {}
    version: dict[str, Any] = {}
    worker_health: dict[str, Any] = {}

    try:
        version = json.loads(fetch(f"{APP}/app-version.json?runtime_check={cache_buster}")[0])
        if not version.get("buildId"):
            errors.append("app-version has no buildId")
    except Exception as exc:
        errors.append(f"app-version failed: {exc}")

    for route in DRIVERS:
        try:
            body, final_url, status = fetch(f"{APP}/{route}?runtime_check={cache_buster}")
            ok = status == 200 and b"PMG Driver" in body and f"/{route}" in final_url
            routes[route] = {"ok": ok, "status": status, "finalUrl": final_url}
            if not ok:
                errors.append(f"/{route} did not serve its driver app route")
        except Exception as exc:
            routes[route] = {"ok": False, "error": str(exc)}
            errors.append(f"/{route} failed: {exc}")

    try:
        local_version = json.loads(LOCAL_APP_VERSION.read_text(encoding="utf-8"))
    except Exception:
        local_version = {}
    expected_worker, expected_worker_source = expected_worker_build(version, local_version)
    expected_contract = str(version.get("driverApiContract") or "")
    try:
        worker_health = json.loads(fetch(f"{WORKER}/health?runtime_check={cache_buster}")[0])
        if not worker_health.get("ok"):
            errors.append("worker health did not return ok")
        if expected_worker and worker_health.get("workerBuildId") != expected_worker:
            errors.append("frontend/worker build mismatch")
        if expected_contract and worker_health.get("driverApiContract") != expected_contract:
            errors.append("frontend/worker API contract mismatch")
        if worker_health.get("runtimePatchId") != REQUIRED_RUNTIME_PATCH_ID:
            errors.append("driver load-attachment runtime patch missing")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 404) and not expected_worker:
            warnings.append("legacy live build has no worker compatibility endpoint")
        else:
            errors.append(f"worker health failed: HTTP {exc.code}")
    except Exception as exc:
        errors.append(f"worker health failed: {exc}")

    sync_key = os.environ.get("PMG_DRIVER_SYNC_KEY", "").strip()
    if not sync_key and PROJECT_INDEX.is_file():
        match = re.search(r"const API_KEY = '([^']+)'", PROJECT_INDEX.read_text(encoding="utf-8"))
        sync_key = match.group(1) if match else ""
    authenticated: dict[str, Any] = {"checked": False}
    if sync_key:
        headers = {"X-PMG-Key": sync_key}
        authenticated["checked"] = True
        try:
            auth = json.loads(fetch(f"{WORKER}/haultech-auth-status", headers)[0])
            authenticated["haultechAuth"] = {
                "hasToken": bool(auth.get("hasToken")),
                "expired": bool(auth.get("expired")),
            }
            if not auth.get("hasToken") or auth.get("expired"):
                errors.append("Haultech token is missing or expired")
        except Exception as exc:
            errors.append(f"Haultech auth status failed: {exc}")
        today = datetime.now().date().isoformat()
        try:
            jobs = json.loads(fetch(f"{WORKER}/ht/jobs?date={today}", headers)[0])
            rows = jobs if isinstance(jobs, list) else (jobs.get("items") or jobs.get("data") or [])
            authenticated["todayJobCount"] = len(rows)
        except Exception as exc:
            errors.append(f"live Haultech job pull failed: {exc}")
    else:
        warnings.append("PMG_DRIVER_SYNC_KEY unavailable; authenticated Haultech pull was skipped")

    return {
        "workflow": "pmg-driver-app-runtime-health",
        "checkedAt": checked_at,
        "status": "red" if errors else ("amber" if warnings else "green"),
        "buildId": version.get("buildId", ""),
        "workerBuildId": worker_health.get("workerBuildId", ""),
        "runtimePatchId": worker_health.get("runtimePatchId", ""),
        "expectedWorkerBuildId": expected_worker,
        "expectedWorkerSource": expected_worker_source,
        "driverApiContract": worker_health.get("driverApiContract", ""),
        "routes": routes,
        "authenticatedChecks": authenticated,
        "errors": errors,
        "warnings": warnings,
    }


def write_opencore(payload: dict[str, Any]) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "ledger.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
    route_summary = ", ".join(f"/{name}={'OK' if data.get('ok') else 'FAIL'}" for name, data in payload["routes"].items())
    summary = (
        "# PMG Driver App Runtime Health\n\n"
        f"Checked: {payload['checkedAt']}\n\n"
        "Build authority: Codex owns reusable PMG Driver App build/change work; this file is runtime health evidence only.\n"
        "Freshness: generated by `projects/pmg-driver-app/tools/driver_app_runtime_check.py`; re-run the checker before treating route/API health as current.\n"
        "Post-build review: runtime health checks frontend routes, worker/API contract compatibility, authenticated Haultech read health where available, stale route pointers, and no-send/no-deploy boundaries.\n\n"
        f"Status: `{payload['status']}`\n\n"
        f"Frontend: `{payload['buildId']}`\nWorker: `{payload['workerBuildId'] or 'legacy/unavailable'}`\n"
        f"API contract: `{payload['driverApiContract'] or 'legacy/unavailable'}`\n\n"
        f"Routes: {route_summary}\n\n"
        f"Errors: {json.dumps(payload['errors'], ensure_ascii=False)}\n\n"
        f"Warnings: {json.dumps(payload['warnings'], ensure_ascii=False)}\n"
    )
    (STATE / "latest-summary.md").write_text(summary, encoding="utf-8")
    (STATE / "latest.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-opencore", action="store_true")
    args = parser.parse_args()
    payload = check()
    if args.write_opencore:
        write_opencore(payload)
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 2 if payload["status"] == "red" else 0


if __name__ == "__main__":
    raise SystemExit(main())
