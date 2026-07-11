#!/usr/bin/env python3
"""Stage PMG Plant service evidence and optionally upload it to SharePoint.

This helper mirrors the existing PMG evidence discipline:
- write a readable local evidence pack first;
- upload the folder tree to the Team Site only when requested;
- mark a worker event as linked only after the upload command succeeds.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKSPACE = Path("/Users/bill/.openclaw/workspace")
APP_ROOT = Path("/Users/bill/.openclaw/workspace/projects/pmg-driver-app")
LIVE_UPLOAD_SCRIPT = WORKSPACE / "scripts" / "sharepoint_rest_folder_upload.py"
STATE_DIR = WORKSPACE / "state" / "plant_service_sharepoint_sync"
STATE_PATH = STATE_DIR / "state.json"
OPENCORE_DIR = WORKSPACE / "OPENCORE" / "state" / "plant-service-app"
OPENCORE_LEDGER = OPENCORE_DIR / "ledger.jsonl"
OPENCORE_SUMMARY = OPENCORE_DIR / "latest-summary.md"
LOG_PATH = WORKSPACE / "logs" / "plant-service-sharepoint-sync.log"
APP_VERSION_PATH = APP_ROOT / "app-version.json"
PLANT_SEED_PATH = APP_ROOT / "plant-seed.json"
SERVICE_WORKER_PATH = APP_ROOT / "sw.js"

WORKER_URL = os.environ.get("PMG_DRIVER_WORKER_URL", "https://pmg-driver-sync.jimpmgr.workers.dev").rstrip("/")
API_KEY = os.environ.get("PMG_DRIVER_SYNC_KEY", "pmg2026driver")
LOCAL_STAGING_ROOT = WORKSPACE / "state" / "plant_service_sharepoint_sync" / "staging"
LIVE_SHAREPOINT_UPLOAD_TARGET = "SHARED/Plant and Tool Service Records"
LIVE_SHAREPOINT_TARGET = f"/sites/PMGroundWorksTeamSite/Shared Documents/{LIVE_SHAREPOINT_UPLOAD_TARGET}"
USER_AGENT = "Mozilla/5.0 PMG-Plant-Service-SharePoint-Sync/1.0"


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log(message: str) -> None:
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {message}"
    print(line)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8", dir=str(path.parent)) as fh:
        fh.write(text)
        tmp = Path(fh.name)
    tmp.replace(path)


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def save_json(path: Path, payload: Any) -> None:
    atomic_write_text(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, sort_keys=True) + "\n")


def service_worker_cache_name() -> str:
    try:
        text = SERVICE_WORKER_PATH.read_text(encoding="utf-8")
    except Exception:
        return ""
    match = re.search(r"CACHE_NAME\s*=\s*['\"]([^'\"]+)['\"]", text)
    return match.group(1) if match else ""


def safe_part(value: Any, fallback: str = "unknown", limit: int = 90) -> str:
    text = str(value or "").strip()
    text = re.sub(r"[^\w .@+-]+", "_", text)
    text = re.sub(r"\s+", " ", text).strip(" ._-")
    return (text[:limit].strip(" ._-") or fallback)


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def load_state() -> dict[str, Any]:
    state = load_json(STATE_PATH, {})
    state.setdefault("version", 1)
    state.setdefault("source", f"{WORKER_URL}/plant/sharepoint-export")
    state.setdefault("local_staging_root", str(LOCAL_STAGING_ROOT))
    state.setdefault("sharepoint_root", LIVE_SHAREPOINT_TARGET)
    state.setdefault("staged_events", {})
    state.setdefault("partial_events", {})
    state.setdefault("last_run", {})
    for bucket_name in ("staged_events", "partial_events"):
        bucket = state.get(bucket_name)
        if isinstance(bucket, dict):
            for event_id in list(bucket):
                if str(event_id).startswith("plant-sharepoint-self-test"):
                    bucket.pop(event_id, None)
    return state


def save_state(state: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    save_json(STATE_PATH, state)


def request_url(url: str, *, method: str = "GET", body: bytes | None = None) -> urllib.request.Request:
    headers = {
        "X-PMG-Key": API_KEY,
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    return urllib.request.Request(url, data=body, headers=headers, method=method)


def fetch_json(url: str) -> Any:
    with urllib.request.urlopen(request_url(url), timeout=45) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return json.loads(resp.read().decode(charset))


def post_json(url: str, payload: dict[str, Any]) -> Any:
    body = json.dumps(payload).encode("utf-8")
    with urllib.request.urlopen(request_url(url, method="POST", body=body), timeout=45) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return json.loads(resp.read().decode(charset))


def check_worker_routes() -> dict[str, Any]:
    url = f"{WORKER_URL}/plant/sharepoint-export"
    try:
        with urllib.request.urlopen(request_url(url), timeout=30) as resp:
            charset = resp.headers.get_content_charset() or "utf-8"
            payload = json.loads(resp.read().decode(charset))
            return {
                "ok": resp.status == 200,
                "status": "ready" if resp.status == 200 else "unexpected_status",
                "httpStatus": resp.status,
                "schema": payload.get("schema") if isinstance(payload, dict) else "",
                "pendingEvents": len(payload.get("pendingEvents") or []) if isinstance(payload, dict) else None,
            }
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()
        if exc.code == 404:
            status = "not_deployed"
        elif exc.code == 401:
            status = "unauthorized"
        elif exc.code == 403:
            status = "forbidden"
        else:
            status = "http_error"
        return {"ok": False, "status": status, "httpStatus": exc.code, "detail": detail[:500]}
    except Exception as exc:
        return {"ok": False, "status": "request_failed", "detail": str(exc)[:500]}


def event_date(event: dict[str, Any]) -> str:
    explicit = str(event.get("date") or "")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", explicit):
        return explicit
    created = parse_dt(event.get("createdAt"))
    if created:
        return created.date().isoformat()
    return datetime.now().date().isoformat()


def event_time(event: dict[str, Any]) -> str:
    created = parse_dt(event.get("createdAt"))
    if created:
        return created.astimezone().strftime("%H%M")
    return "time unknown"


def event_folder(root: Path, event: dict[str, Any]) -> Path:
    date = event_date(event)
    plant = safe_part(event.get("plantNumber") or event.get("assetId"), "plant", 35)
    service = safe_part(event.get("serviceType") or event.get("category") or "service", "service", 45)
    suffix = safe_part(str(event.get("id") or "")[-12:], "event", 20)
    folder = f"{event_time(event)} - Plant {plant} - {service} - {suffix}"
    return root / f"Plant {plant}" / date[:4] / date / safe_part(folder, "plant-service", 130)


def local_to_live_path(local_path: str, local_root: Path) -> str:
    try:
        relative = Path(local_path).resolve().relative_to(local_root.resolve()).as_posix()
    except Exception:
        relative = ""
    return f"{LIVE_SHAREPOINT_TARGET}/{relative}".rstrip("/")


def checklist_rows(event: dict[str, Any]) -> list[dict[str, str]]:
    rows = []
    for item in event.get("checklist") or []:
        if not isinstance(item, dict):
            continue
        rows.append({
            "item": str(item.get("item") or "").strip(),
            "status": str(item.get("status") or "").strip(),
            "note": str(item.get("note") or "").strip(),
        })
    return [row for row in rows if row["item"]]


def filter_rows(event: dict[str, Any]) -> list[dict[str, str]]:
    rows = []
    for part in event.get("filterParts") or []:
        if not isinstance(part, dict):
            continue
        rows.append({
            "type": str(part.get("type") or "").strip(),
            "code": str(part.get("code") or "").strip(),
            "notes": str(part.get("notes") or "").strip(),
        })
    return [row for row in rows if row["type"] or row["code"] or row["notes"]]


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8", newline="", dir=str(path.parent)) as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
        tmp = Path(fh.name)
    tmp.replace(path)


def build_markdown(event: dict[str, Any], folder: Path, status: str) -> str:
    checks = checklist_rows(event)
    filters = filter_rows(event)
    next_due_date = event.get("nextDueDate") or ""
    next_due_hours = event.get("nextDueHours") if event.get("nextDueHours") is not None else ""
    next_service_rule = ""
    if next_due_date and next_due_hours != "":
        next_service_rule = f"{next_due_hours} hours or {next_due_date}, whichever comes first"
    lines = [
        "# PMG Plant Service Evidence",
        "",
        f"- Event ID: `{event.get('id', '')}`",
        f"- Plant: `{event.get('plantNumber') or event.get('assetId') or ''}`",
        f"- Asset ID: `{event.get('assetId', '')}`",
        f"- Date: `{event_date(event)}`",
        f"- Category: `{event.get('category', '')}`",
        f"- Service type: `{event.get('serviceType', '')}`",
        f"- Hours: `{event.get('hours') if event.get('hours') is not None else ''}`",
        f"- Next due date: `{next_due_date}`",
        f"- Next due hours: `{next_due_hours}`",
        *([f"- Next service rule: `{next_service_rule}`"] if next_service_rule else []),
        f"- Created by: `{event.get('createdBy') or event.get('sourceName') or ''}`",
        f"- Created at: `{event.get('createdAt') or ''}`",
        f"- SharePoint sync status: `{status}`",
        "",
        "## Work Done",
        "",
        str(event.get("description") or "").strip() or "No work note entered.",
        "",
        "## Anomalies",
        "",
        str(event.get("anomalies") or "").strip() or "No anomalies recorded.",
        "",
        "## Tick Sheet",
        "",
    ]
    if checks:
        lines.extend(["| Item | Status | Note |", "|---|---|---|"])
        for row in checks:
            lines.append(f"| {row['item']} | {row['status']} | {row['note']} |")
    else:
        lines.append("- No tick sheet rows recorded.")

    lines.extend(["", "## Filters / Parts", ""])
    if filters:
        lines.extend(["| Type | Code | Notes |", "|---|---|---|"])
        for row in filters:
            lines.append(f"| {row['type']} | {row['code']} | {row['notes']} |")
    else:
        lines.append("- No filter or parts updates recorded on this service entry.")

    lines.extend([
        "",
        "## Source",
        "",
        f"- Source system: PMG Plant Information Hub",
        f"- Source endpoint: `{WORKER_URL}/plant/sharepoint-export`",
        f"- Local staging folder: `{folder}`",
        f"- Live SharePoint target required: `{LIVE_SHAREPOINT_TARGET}`",
        f"- Evidence pack generated at: `{now_utc()}`",
        "",
        "This pack is the office/audit copy of a plant service or repair entry submitted in the PMG Plant Information Hub.",
        "",
    ])
    return "\n".join(lines)


def write_html_summary(folder: Path, markdown_text: str) -> None:
    body = html.escape(markdown_text)
    html_text = (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        "<title>PMG Plant Service Evidence</title>"
        "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;"
        "max-width:920px;margin:32px auto;padding:0 20px;line-height:1.45;color:#111827}"
        "pre{white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;padding:16px}"
        "</style></head><body><pre>"
        + body
        + "</pre></body></html>\n"
    )
    atomic_write_text(folder / "plant-service-summary.html", html_text)


def stage_event(
    event: dict[str, Any],
    root: Path,
    state: dict[str, Any],
    *,
    force: bool,
    dry_run: bool,
    write_opencore: bool = True,
) -> dict[str, Any]:
    event_id = str(event.get("id") or "")
    if not event_id:
        return {"status": "skipped", "reason": "missing_event_id"}
    if state["staged_events"].get(event_id) and not force:
        return {"status": "skipped", "reason": "already_staged", "event_id": event_id}
    folder = event_folder(root, event)
    if dry_run:
        return {"status": "would_stage", "event_id": event_id, "sharepoint_path": str(folder)}

    folder.mkdir(parents=True, exist_ok=True)
    atomic_write_text(folder / "plant-service-event.json", json.dumps(event, indent=2, sort_keys=True) + "\n")
    checks = checklist_rows(event)
    filters = filter_rows(event)
    write_csv(folder / "checksheet.csv", ["item", "status", "note"], checks)
    write_csv(folder / "filters-parts.csv", ["type", "code", "notes"], filters)
    status = "staged"
    markdown = build_markdown(event, folder, status)
    atomic_write_text(folder / "plant-service-summary.md", markdown)
    write_html_summary(folder, markdown)

    fact = {
        "event": "plant_service_sharepoint_stage",
        "updated_at": now_utc(),
        "status": status,
        "event_id": event_id,
        "date": event_date(event),
        "asset_id": event.get("assetId") or "",
        "plant_number": event.get("plantNumber") or "",
        "category": event.get("category") or "",
        "service_type": event.get("serviceType") or "",
        "hours": event.get("hours"),
        "next_due_date": event.get("nextDueDate") or "",
        "next_due_hours": event.get("nextDueHours"),
        "check_count": len(checks),
        "filter_part_count": len(filters),
        "anomalies_present": bool(str(event.get("anomalies") or "").strip()),
        "local_staging_path": str(folder),
        "sharepoint_path": str(folder),
        "live_sharepoint_target": LIVE_SHAREPOINT_TARGET,
        "live_sharepoint_status": "not_verified_by_this_helper",
        "source": f"{WORKER_URL}/plant/sharepoint-export",
    }
    if write_opencore:
        append_jsonl(OPENCORE_LEDGER, fact)
    state["staged_events"][event_id] = fact
    state["partial_events"].pop(event_id, None)
    return fact


def upload_unlinked_to_live_sharepoint(local_root: Path, state: dict[str, Any]) -> dict[str, Any]:
    pending = [
        row for row in state.get("staged_events", {}).values()
        if not str(row.get("event_id") or "").startswith("plant-sharepoint-self-test")
        if not str(row.get("live_sharepoint_status") or "").startswith("verified_live_sharepoint_rest_upload")
        and Path(str(row.get("local_staging_path") or "")).is_dir()
    ]
    result = {
        "event": "plant_service_live_sharepoint_upload",
        "updated_at": now_utc(),
        "status": "skipped_no_unverified_events",
        "pending_events": len(pending),
        "target": LIVE_SHAREPOINT_UPLOAD_TARGET,
        "live_sharepoint_target": LIVE_SHAREPOINT_TARGET,
    }
    if not pending:
        return result
    if not any(local_root.rglob("*")):
        result["status"] = "skipped_no_local_files"
        return result

    manifest = STATE_DIR / f"sharepoint-plant-live-upload-manifest-{datetime.now().strftime('%Y%m%d-%H%M%S')}.csv"
    cmd = [
        sys.executable,
        str(LIVE_UPLOAD_SCRIPT),
        "--source",
        str(local_root),
        "--target",
        LIVE_SHAREPOINT_UPLOAD_TARGET,
        "--manifest",
        str(manifest),
        "--progress-every",
        "50",
    ]
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=900, check=False)
    except Exception as exc:
        result.update({"status": "failed", "error": str(exc)[:1000]})
        append_jsonl(OPENCORE_LEDGER, result)
        return result

    result["returncode"] = proc.returncode
    result["stdout_tail"] = proc.stdout[-2000:]
    result["stderr_tail"] = proc.stderr[-2000:]
    result["manifest"] = str(manifest)
    if proc.returncode != 0:
        result["status"] = "failed"
        append_jsonl(OPENCORE_LEDGER, result)
        return result

    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    verified_status = f"verified_live_sharepoint_rest_upload_{stamp}"
    for row in pending:
        row["live_sharepoint_status"] = verified_status
        row["live_sharepoint_verified_path"] = local_to_live_path(str(row.get("local_staging_path") or ""), local_root)
    result.update({
        "status": "verified",
        "verified_events": len(pending),
        "verified_status": verified_status,
    })
    append_jsonl(OPENCORE_LEDGER, result)
    return result


def mark_worker_links(state: dict[str, Any], *, dry_run: bool) -> dict[str, Any]:
    rows = [
        row for row in state.get("staged_events", {}).values()
        if str(row.get("live_sharepoint_status") or "").startswith("verified_live_sharepoint_rest_upload")
        and not row.get("worker_linked_at")
    ]
    result = {"event": "plant_service_worker_linkback", "updated_at": now_utc(), "pending_links": len(rows), "linked": 0, "failed": 0}
    for row in rows:
        payload = {
            "eventId": row["event_id"],
            "sharePointEvidencePath": row.get("live_sharepoint_verified_path") or row.get("local_staging_path") or "",
        }
        if dry_run:
            result["linked"] += 1
            continue
        try:
            post_json(f"{WORKER_URL}/plant/evidence-links", payload)
            row["worker_linked_at"] = now_utc()
            result["linked"] += 1
        except Exception as exc:
            result["failed"] += 1
            row["worker_link_error"] = str(exc)[:500]
    append_jsonl(OPENCORE_LEDGER, result)
    return result


def write_latest_summary(state: dict[str, Any], run: dict[str, Any]) -> None:
    staged = list(state.get("staged_events", {}).values())[-12:]
    app_version = load_json(APP_VERSION_PATH, {})
    seed = load_json(PLANT_SEED_PATH, {})
    seed_stats = seed.get("stats", {}) if isinstance(seed.get("stats"), dict) else {}
    app_build_id = str(app_version.get("buildId") or "unknown")
    cache_name = service_worker_cache_name() or "unknown"
    lines = [
        "# PMG Plant Service App",
        "",
        f"Last updated: {now_utc()}",
        "",
        "## Source Of Truth",
        "",
        f"- Structured live plant state: `{WORKER_URL}/plant/*`.",
        "- Katie admin feed: `/Users/bill/Desktop/HGV, VEHICLE & PLANT SERVICE SHEET.xlsx`.",
        "- Current location/identity schedule: `/Users/bill/.openclaw/workspace/shared-docs/PMG/Plant Schedule revised 2024.xlsx`.",
        "- Legacy OneDrive fallback is disabled by default to avoid background-access hangs; it is used only when `PMG_PLANT_INCLUDE_LEGACY_SCHEDULE=1` is set explicitly.",
        "- Evidence root displayed on plant records: `SHARED/Plant and Tool Service Records`.",
        "",
        "## Live App",
        "",
        "- Tony mechanic URL: `https://pmg-driver-app.pages.dev/tony`; it forwards cleanly into the Tony-only plant mechanic app.",
        "- Compatibility plant URL: `https://pmg-driver-app.pages.dev/plant` serves the same Tony-only mechanic app for existing bookmarks.",
        "- Future Jim overview: not part of Tony's mechanic app; build later by consuming the plant mechanic data, HGV/driver history, costs and evidence links.",
        f"- Static build ID: `{app_build_id}`.",
        f"- Service worker cache: `{cache_name}`.",
        f"- Imported snapshot: `{seed_stats.get('assetCount', 0)}` plant/tool assets, `{seed_stats.get('historyEventCount', 0)}` service/history rows, `{seed_stats.get('filterPartCount', 0)}` filter/parts rows and `{seed_stats.get('reviewItemCount', 0)}` import-review rows retained for later admin/overview use but hidden from Tony.",
        f"- Spare schedule rows skipped: `{seed_stats.get('unusedSchedulePlantNumberCount', 0)}` unused plant numbers are not shown to Tony as needing first setup.",
        f"- Annual service schedule: `{seed_stats.get('serviceDateScheduleCount', 0)}` plant items currently have a 12-month service due date calculated from known last-service information.",
        "- Tony service rule: plant service is due at `500` hours or `12` months, whichever comes first. Tony can still choose `250`, `500`, `750` or `1000` hours for the next service interval.",
        "- Tony schedule reviews: `Service schedule review` is available for machines that are time-overdue but not yet service-due by real hours. It records as an inspection/review, not a full service, and applies the explicit next due date/hours Tony enters.",
        "- Tony hire checks: `Pre / post hire check` is available in the service type dropdown for quick hire/job turnarounds. It records as an inspection/check with comments and parts available. It does not reset the 500-hour/12-month service schedule unless Tony explicitly enters new next due date or next due hours values.",
        "- Tony service alerts: the app shows simple in-app reminders when plant is overdue or due in `30`, `15` or `2` days; service entries and explicit schedule-review updates move the next due date/hours forward and clear the old alert automatically. If Tony logs a date-only annual service, the old hour-service target is cleared so it does not keep alerting.",
        "- Tony push notifications: Tony can enable Home Screen app notifications on his phone; the worker checks around `08:00` UK time and sends a push only when a plant service alert is due/overdue.",
        "- Tony service entries: service rows auto-fill the next due date to 12 months after the service date; repair, inspection and parts rows do not auto-fill a service due date unless a schedule review is being entered explicitly.",
        "- Tony print sheet: the selected plant record includes a simple print action for machine identity, service status, history, filters/parts and evidence path.",
        "- Tony history and filter/parts views: imported plant workbook rows show date, type, hours, supplier/work details, reference numbers and useful filter/part clues; prices remain hidden from Tony and are reserved for the later overview/cost app.",
        "",
        "## Plant SharePoint Evidence Sync",
        "",
        f"- Local staging root: `{state.get('local_staging_root')}`",
        f"- Live SharePoint target: `{LIVE_SHAREPOINT_TARGET}`",
        "- Scheduler: quiet macOS LaunchAgent `com.pmg.plant-service-sharepoint-sync`; the old Codex hourly automation is paused so routine no-work syncs do not create visible Codex chats.",
        f"- Last run status: `{run.get('status')}`",
        f"- Last run pending worker events: `{run.get('pending_events', 0)}`",
        f"- Last run staged now: `{run.get('staged_now', 0)}`",
        f"- Last live upload status: `{run.get('live_upload_status', 'not_attempted')}`",
        f"- Last worker linkback status: `{run.get('worker_link_status', 'not_attempted')}`",
        f"- Total staged events: `{len(state.get('staged_events', {}))}`",
        "",
        "Detailed OpenCore facts written per service event: event ID, plant number, date, category, service type, hours, next due values, check count, filter/part count, anomaly flag, local staging path, live SharePoint target and verification status.",
        "",
        "Post-build review: checked live-vs-local source pointers, duplicate-source risk between the revised and legacy plant schedules, spare schedule false positives/negatives, verified-only completion rules for SharePoint evidence, downstream worker linkback compatibility, Tony's 500-hour-or-12-month service rule, Tony's pre/post hire check classification as inspection, explicit service schedule review updates, date-only annual service alert reset, Tony's selected-plant print sheet, Tony's 30/15/2-day in-app service alerts, Tony's opt-in push notification route, Tony history/filter price hiding, and the generated OpenCore latest-summary path.",
        "",
        "## Recent Plant Evidence Events",
        "",
    ]
    if staged:
        for row in staged:
            display_path = row.get("live_sharepoint_verified_path") or row.get("local_staging_path")
            lines.append(
                f"- `{row.get('date')}` Plant `{row.get('plant_number')}` `{row.get('service_type')}` "
                f"-> `{display_path}` (live SharePoint: `{row.get('live_sharepoint_status', 'not_verified')}`)"
            )
    else:
        lines.append("- None yet.")
    lines.append("")
    atomic_write_text(OPENCORE_SUMMARY, "\n".join(lines))


def load_pending_events(args: argparse.Namespace) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if args.self_test:
        event = {
            "id": "plant-sharepoint-self-test-2026-06-04",
            "assetId": "plant-27",
            "plantNumber": "27",
            "date": "2026-06-04",
            "category": "service",
            "sourceName": "Tony mechanic app",
            "createdBy": "Tony",
            "createdAt": "2026-06-04T15:55:00+01:00",
            "hours": 3900,
            "nextDueHours": 4400,
            "serviceType": "500 hour service",
            "description": "Self-test service pack for SharePoint evidence writer.",
            "anomalies": "",
            "checklist": [
                {"item": "Engine oil", "status": "Done", "note": ""},
                {"item": "Fuel filter", "status": "Done", "note": ""},
                {"item": "Test run", "status": "Good", "note": ""},
            ],
            "filterParts": [{"type": "Oil filter", "code": "W21ES01600", "notes": "Self-test"}],
            "sharePointWriteState": "queued_for_sharepoint_evidence",
        }
        return [event], {"schema": "self-test"}
    if args.from_json:
        payload = load_json(Path(args.from_json).expanduser(), {})
        if isinstance(payload, list):
            return payload, {"schema": "local-list"}
        return payload.get("pendingEvents") or [], payload
    payload = fetch_json(f"{WORKER_URL}/plant/sharepoint-export")
    return payload.get("pendingEvents") or [], payload


def run_sync(args: argparse.Namespace) -> int:
    root = Path(args.output_root).expanduser() if args.output_root else LOCAL_STAGING_ROOT
    state = load_state()
    state["source"] = f"{WORKER_URL}/plant/sharepoint-export"
    state["local_staging_root"] = str(root)
    state["sharepoint_root"] = LIVE_SHAREPOINT_TARGET
    run = {
        "started_at": now_utc(),
        "status": "started",
        "pending_events": 0,
        "staged_now": 0,
        "skipped_now": 0,
        "errors": [],
    }
    write_run_state = True

    try:
        if args.check_worker:
            readiness = check_worker_routes()
            print(json.dumps(readiness, indent=2))
            write_run_state = False
            return 0 if readiness.get("ok") else 2
        if not args.self_test and not args.from_json:
            readiness = check_worker_routes()
            run["worker_route_status"] = readiness
            if not readiness.get("ok"):
                run["status"] = "blocked_worker_routes_not_live" if readiness.get("status") == "not_deployed" else "blocked_worker_route_unavailable"
                run["errors"].append(json.dumps(readiness, sort_keys=True))
                write_run_state = False
                log(f"{run['status']}: {readiness}")
                return 2
        root.mkdir(parents=True, exist_ok=True)
        events, payload = load_pending_events(args)
        if args.date:
            events = [event for event in events if event_date(event) == args.date]
        run["pending_events"] = len(events)
        run["payload_schema"] = payload.get("schema") if isinstance(payload, dict) else ""

        for event in events:
            result = stage_event(event, root, state, force=args.force, dry_run=args.dry_run, write_opencore=not args.self_test)
            if result.get("status") == "staged":
                run["staged_now"] += 1
            else:
                run["skipped_now"] += 1

        run["status"] = "dry_run_ok" if args.dry_run else "ok"
        if not args.dry_run and not args.skip_live_upload:
            live_upload = upload_unlinked_to_live_sharepoint(root, state)
            run["live_upload_status"] = live_upload.get("status")
            if live_upload.get("status") == "failed":
                run["errors"].append("live SharePoint upload failed; local staging retained")
                run["status"] = "failed"
            elif live_upload.get("status") == "verified":
                run["live_upload_verified_events"] = live_upload.get("verified_events", 0)
        if not args.dry_run and not args.skip_worker_link:
            link = mark_worker_links(state, dry_run=False)
            run["worker_link_status"] = "failed" if link.get("failed") else "ok"
            run["worker_linked"] = link.get("linked", 0)
            if link.get("failed"):
                run["errors"].append("worker linkback failed for one or more events")
                run["status"] = "failed"
    except urllib.error.HTTPError as exc:
        run["status"] = "failed"
        detail = exc.read().decode("utf-8", errors="replace").strip()
        run["errors"].append(f"HTTP {exc.code}: {detail[:500]}")
        log(f"failed: HTTP {exc.code} {detail[:300]}")
    except Exception as exc:
        run["status"] = "failed"
        run["errors"].append(str(exc))
        log(f"failed: {exc}")
    finally:
        run["finished_at"] = now_utc()
        state["last_run"] = run
        if not args.dry_run and not args.self_test and write_run_state:
            save_state(state)
            append_jsonl(OPENCORE_LEDGER, {"event": "plant_service_sharepoint_sync_run", **run, "updated_at": now_utc()})
            write_latest_summary(state, run)

    log(
        f"{run['status']}: pending={run['pending_events']} staged={run['staged_now']} skipped={run['skipped_now']} "
        f"live={run.get('live_upload_status', 'not_attempted')}"
    )
    return 0 if run["status"] in {"ok", "dry_run_ok"} else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage PMG Plant service evidence pending live SharePoint upload.")
    parser.add_argument("--date", help="Only sync one ISO date, e.g. 2026-06-04.")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and plan only; do not write evidence packs/state.")
    parser.add_argument("--force", action="store_true", help="Rebuild already-staged evidence packs.")
    parser.add_argument("--output-root", help="Override the local staging folder.")
    parser.add_argument("--from-json", help="Read pending event export JSON from a local file.")
    parser.add_argument("--skip-live-upload", action="store_true", help="Stage locally only; do not attempt the live SharePoint REST upload.")
    parser.add_argument("--skip-worker-link", action="store_true", help="Do not POST confirmed SharePoint paths back to the worker.")
    parser.add_argument("--check-worker", action="store_true", help="Check whether the live PMG worker has the plant SharePoint export route deployed.")
    parser.add_argument("--self-test", action="store_true", help="Generate a synthetic plant service pack.")
    return parser.parse_args()


def main() -> int:
    return run_sync(parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
