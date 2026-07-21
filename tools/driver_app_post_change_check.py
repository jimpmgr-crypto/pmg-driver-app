#!/usr/bin/env python3
"""Post-change live checks for the PMG driver app.

This is deliberately narrow: it catches the mistakes that make drivers have to
redo work after a driver-app/Haultech change.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
import time
import urllib.request
from datetime import date, datetime
from pathlib import Path
from typing import Any


WORKSPACE = Path("/Users/bill/.openclaw/workspace")
PROJECT = WORKSPACE / "projects" / "pmg-driver-app"
DRIVER_NAMES = ("john bowman", "andrew whittaker", "richard whittaker", "neil", "ian")

SCRIPTS_DIR = str(WORKSPACE / "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
      raise RuntimeError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live PMG driver app post-change check.")
    parser.add_argument("--date", default=date.today().isoformat(), help="Haultech date to check, YYYY-MM-DD.")
    parser.add_argument("--expected-build", default="", help="Expected app-version.json buildId.")
    return parser.parse_args()


def validate_date(raw: str) -> date:
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError as exc:
        raise SystemExit(f"Invalid --date {raw!r}; use YYYY-MM-DD") from exc


def first_consignment(job: dict[str, Any]) -> dict[str, Any]:
    consignments = job.get("consignments") or []
    return consignments[0] if consignments and isinstance(consignments[0], dict) else {}


def job_text(job: dict[str, Any]) -> str:
    return json.dumps(job, default=str, ensure_ascii=False)


def is_phone_added(job: dict[str, Any]) -> bool:
    text = job_text(job).lower()
    return "added by " in text or any(name in text for name in DRIVER_NAMES)


def load_status(load: dict[str, Any]) -> str:
    return str(load.get("status") or load.get("loadStatus") or "").strip()


def job_status(job: dict[str, Any]) -> str:
    return str(job.get("deliveryStatus") or job.get("status") or "").strip()


def job_id(job: dict[str, Any]) -> str:
    return str(job.get("jobId") or job.get("jobNumber") or job.get("id") or "?")


def app_build_id() -> str:
    cache_buster = time.time_ns()
    req = urllib.request.Request(
        f"https://pmg-driver-app.pages.dev/app-version.json?post_change_check={cache_buster}",
        headers={
            "Cache-Control": "no-cache",
            "User-Agent": "Mozilla/5.0 PMGDriverPostChangeCheck/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode())
    return str(payload.get("buildId") or "")


def main() -> int:
    args = parse_args()
    target = validate_date(args.date)
    issues: list[str] = []

    if args.expected_build:
        try:
            live_build = app_build_id()
        except Exception as exc:
            issues.append(f"app-version read failed: {exc}")
        else:
            if live_build != args.expected_build:
                issues.append(f"app-version mismatch: live {live_build!r}, expected {args.expected_build!r}")

    ea = load_module("ea_haultech_sync_post_change", WORKSPACE / "scripts" / "ea-haultech-sync.py")
    jobs = ea.fetch_haultech_jobs_with_token_file(target, target)

    for job in jobs:
        text = job_text(job)
        if re.search(r"\blocal-\d+\b", text, re.I):
            issues.append(f"job {job_id(job)} still contains local phone id")
        if is_phone_added(job) and job_status(job).lower() == "completed":
            missing = []
            if not job.get("deliveryLoadId") and not job.get("deliveryLoadNumber"):
                missing.append("load")
            if not job.get("deliveryDriverId"):
                missing.append("driver")
            if not job.get("deliveryVehicleId"):
                missing.append("vehicle")
            if missing:
                issues.append(f"completed phone-added job {job_id(job)} missing {', '.join(missing)}")
        consignment = first_consignment(job)
        ref = str(job.get("customerReference") or consignment.get("consignmentReference") or "")
        if is_phone_added(job) and re.match(r"^\s*(driver|local)-\d+\s*$", ref, re.I):
            issues.append(f"phone-added job {job_id(job)} has bad customer reference {ref!r}")

    yd = load_module("haultech_yard_load_dry_run_post_change", WORKSPACE / "scripts" / "haultech-yard-load-dry-run.py")
    headers = yd.load_token_headers()
    loads = yd.fetch_loads(target, headers)
    if not loads.ok:
        issues.append(f"load diary read failed: {loads.error}")
    for load in loads.items:
        delivery_jobs = [row for row in (load.get("deliveryJobs") or []) if isinstance(row, dict)]
        if not delivery_jobs:
            continue
        if all(job_status(row).lower() == "completed" for row in delivery_jobs) and load_status(load).lower() != "completed":
            issues.append(f"load {load.get('loadId') or load.get('id')} has all jobs complete but header is {load_status(load)!r}")

    if issues:
        print("DRIVER_APP_POST_CHANGE_CHECK_FAILED")
        for issue in issues:
            print(f"- {issue}")
        return 2

    print(f"driver app post-change check passed for {target.isoformat()} ({len(jobs)} jobs)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
