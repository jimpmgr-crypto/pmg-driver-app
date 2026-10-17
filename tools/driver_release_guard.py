#!/usr/bin/env python3
"""Build and optionally deploy one verified PMG Driver App release.

The deploy artifact is created in a temporary directory from an explicit
allow-list, so old work/scratch folders can never become production by mistake.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


CANONICAL_PROJECT = Path("/Users/bill/.openclaw/workspace/projects/pmg-driver-app").resolve()
PROJECT = Path(__file__).resolve().parents[1]
PAGES_PROJECT = "pmg-driver-app"
LIVE_URL = "https://pmg-driver-app.pages.dev"
WORKER_HEALTH_URL = "https://pmg-driver-sync.jimpmgr.workers.dev/health"
DEPLOY_FILES = (
    "_redirects",
    "app-version.json",
    "icon.png",
    "icon-192.png",
    "icon-512.png",
    "index.html",
    "job-backup-journal.js",
    "manifest.json",
    "plant-manifest.json",
    "plant-seed.json",
    "plant.html",
    "plant-write-journal.js",
    "ref-job-detail.jpg",
    "ref-sign-screen.jpg",
    "sw.js",
)


def run(command: list[str], *, cwd: Path = PROJECT, capture: bool = False) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(command))
    return subprocess.run(
        command,
        cwd=cwd,
        text=True,
        check=True,
        capture_output=capture,
    )


def output(command: list[str]) -> str:
    return run(command, capture=True).stdout.strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def validate_source() -> dict:
    require(Path.cwd().resolve() == PROJECT, f"Run from the source checkout: {PROJECT}")
    source_common = output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])
    canonical_common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=CANONICAL_PROJECT, text=True, check=True, capture_output=True).stdout.strip()
    require(Path(source_common).resolve() == Path(canonical_common).resolve(), "Source must be the canonical repository or its managed Git worktree")
    version = json.loads((PROJECT / "app-version.json").read_text())
    index = (PROJECT / "index.html").read_text()
    browser_audit = (PROJECT / "tests" / "driver_app_browser_audit.spec.js").read_text()
    worker = (PROJECT / "worker/index.js").read_text()
    service_worker = (PROJECT / "sw.js").read_text()
    app_shell = service_worker[service_worker.index("const APP_SHELL"):service_worker.index("// Install")]

    build_id = str(version.get("buildId") or "")
    worker_build = str(version.get("expectedWorkerBuildId") or "")
    contract = str(version.get("driverApiContract") or "")
    require(build_id and re.fullmatch(r"[A-Za-z0-9._-]+", build_id), "Invalid buildId")
    require(f"const APP_BUILD_ID = '{build_id}'" in index, "index/app-version build mismatch")
    require(f"pmg-driver-live-v{build_id}" in service_worker, "service-worker/app-version build mismatch")
    require(worker_build and f"const WORKER_BUILD_ID = '{worker_build}'" in worker, "worker build mismatch")
    require(contract and f"const DRIVER_API_CONTRACT = '{contract}'" in worker, "worker API contract mismatch")
    require("const WORKER_RUNTIME_PATCH_ID = '20261007-day-sheet-pricing-r7'" in worker, "current day-sheet pricing runtime patch missing")
    require("function isHistoricalCompletedJobForDate" in worker, "historical completed-job filter missing")
    require("const visibleJobs = visibleHaultechJobsForDate(jobs, date)" in worker, "shared Haultech feed does not apply the historical completed-job filter")
    require("photoEvidenceRequired: true" in index, "walkaround photos are not marked required")
    require("missing.push(`${slot.label} photo`)" in index, "missing walkaround photo gate")
    require("navigator.mediaDevices.getUserMedia" in index, "inline walkaround camera is missing")
    require("function captureInlineWalkaroundPhoto" in index, "sequential inline camera capture is missing")
    require("function launchNativeWalkaroundCamera" in index, "native camera fallback is missing")
    require("input.value = '';" in index, "native camera input reset is missing")
    require("one inline camera session advances through consecutive walkaround photos" in browser_audit, "consecutive camera regression test is missing")
    require("camera permission denial leaves a reusable native camera fallback" in browser_audit, "camera permission fallback regression test is missing")
    require("Reference / name / ticket number — required" in index, "manual reference is not prominent/required")
    require("Notes for office / invoicing — required" in index, "manual notes are not prominent/required")
    for forbidden in ("'/plant'", "'/tony'", "'/plant-seed.json'", "'/plant-manifest.json'"):
        require(forbidden not in app_shell, f"plant asset remains in critical driver shell: {forbidden}")
    for relative in DEPLOY_FILES:
        require((PROJECT / relative).is_file(), f"missing deploy file: {relative}")
    return version


def validate_git(*, require_main: bool) -> tuple[str, str]:
    require(output(["git", "status", "--porcelain"]) == "", "working tree is dirty")
    branch = output(["git", "branch", "--show-current"])
    commit = output(["git", "rev-parse", "HEAD"])
    if require_main:
        require(branch in ("main", ""), f"production deploy requires main or detached origin/main, not {branch!r}")
        run(["git", "fetch", "origin", "main"])
        require(output(["git", "rev-parse", "origin/main"]) == commit, "HEAD must be pushed to origin/main before deploy")
    return branch, commit


def run_checks(*, browser: bool, browser_evidence: Path | None = None) -> None:
    run(["python3", "-m", "py_compile", "tools/driver_release_guard.py", "tools/driver_app_runtime_check.py"])
    run(["node", "--check", "worker/index.js"])
    run(["node", "--check", "sw.js"])
    run(["npm", "run", "test:unit"])
    run(["npx", "wrangler", "deploy", "--dry-run"], cwd=PROJECT / "worker")
    if browser_evidence:
        validate_browser_evidence(browser_evidence)
    elif browser:
        raise RuntimeError("Browser checks must use the supported CUA surface; supply --browser-evidence after source-bound checks")
    run(["python3", "/Users/bill/.openclaw/workspace/scripts/pmg-app-lane-guard.py"])


def evidence_files() -> tuple[str, ...]:
    return tuple(sorted(set(DEPLOY_FILES) | {"worker/wrangler.toml"} | {str(path.relative_to(PROJECT)) for path in (PROJECT / "worker").glob("*.js")}))


def validate_browser_evidence(path: Path) -> dict:
    evidence = json.loads(path.read_text())
    require(evidence.get("method") == "CUA" and evidence.get("status") == "passed", "Missing passing CUA browser evidence")
    checks = evidence.get("checks")
    require(isinstance(checks, list) and checks and all(check.get("status") == "passed" for check in checks), "Browser evidence contains failed or unresolved checks")
    required = {"driver-recovery", "plant-native-journal", "plant-lost-reply", "safe-update", "yard-recovery"}
    require(required <= {check.get("group") for check in checks}, "Required browser scenario coverage is incomplete")
    hashes = evidence.get("sourceHashes", {})
    require(set(hashes) == set(evidence_files()), "Browser evidence must bind all published files and worker modules/config")
    for relative in evidence_files():
        require(hashes.get(relative) == sha256(PROJECT / relative), f"Browser evidence is stale for {relative}")
    require(bool(evidence.get("observedAt")) and bool(evidence.get("independentReview")), "Browser evidence needs date and independent review reference")
    return evidence


def build_artifact(target: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for relative in DEPLOY_FILES:
        source = PROJECT / relative
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        hashes[relative] = sha256(destination)
    (target / "release-hashes.json").write_text(json.dumps(hashes, indent=2, sort_keys=True) + "\n")
    return hashes


def fetch(url: str) -> tuple[bytes, str]:
    request = urllib.request.Request(
        url,
        headers={"Cache-Control": "no-cache", "User-Agent": "PMGDriverReleaseGuard/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read(), response.geturl()


def verify_live(version: dict, hashes: dict[str, str]) -> None:
    expected_build = version["buildId"]
    expected_worker = version["expectedWorkerBuildId"]
    release_token = time.time_ns()
    last_error = "live verification timed out"
    for attempt in range(12):
        try:
            check_token = f"{release_token}-{attempt}"
            live_version = json.loads(fetch(f"{LIVE_URL}/app-version.json?release_check={check_token}")[0])
            worker_health = json.loads(fetch(f"{WORKER_HEALTH_URL}?release_check={check_token}")[0])
            require(live_version.get("buildId") == expected_build, "live frontend build mismatch")
            require(worker_health.get("workerBuildId") == expected_worker, "live worker build mismatch")
            require(worker_health.get("driverApiContract") == version.get("driverApiContract"), "live API contract mismatch")
            for relative in ("index.html", "sw.js"):
                # Cloudflare Pages canonicalises /index.html to / with a 308.
                # Hash the canonical root response instead of treating that
                # healthy clean-URL redirect as a failed deployment.
                live_path = "" if relative == "index.html" else relative
                live_bytes, _ = fetch(f"{LIVE_URL}/{live_path}?release_check={check_token}")
                live_hash = hashlib.sha256(live_bytes).hexdigest()
                require(live_hash == hashes[relative], f"live {relative} hash mismatch")
            for route in ("john", "andrew", "neil", "ian", "richard", "paul"):
                body, final_url = fetch(f"{LIVE_URL}/{route}?release_check={check_token}")
                require(b"PMG Driver" in body, f"/{route} did not serve driver app")
                require(f"/{route}" in final_url, f"/{route} redirected away from its driver path")
            print(f"LIVE_OK frontend={expected_build} worker={expected_worker}")
            return
        except Exception as exc:  # propagation/cache convergence
            last_error = str(exc)
            if attempt < 11:
                time.sleep(5)
    raise RuntimeError(last_error)


def deploy(version: dict, hashes: dict[str, str], artifact: Path, commit: str) -> None:
    run(["npx", "wrangler", "deploy"], cwd=PROJECT / "worker")
    run([
        "npx", "wrangler", "pages", "deploy", str(artifact),
        "--project-name", PAGES_PROJECT,
        "--branch", "main",
        "--commit-hash", commit,
        "--commit-message", f"Driver app {version['buildId']}",
        "--commit-dirty=false",
    ])
    verify_live(version, hashes)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", action="store_true", help="Run the full mobile Playwright suite.")
    parser.add_argument("--stage", type=Path, help="Stage exact verified artifact for a coordinated backend migration then Pages deployment.")
    parser.add_argument("--browser-evidence", type=Path, help="Passing CUA report bound to the exact release files and worker modules.")
    parser.add_argument("--deploy", action="store_true", help="Deploy worker and exact tested Pages artifact.")
    parser.add_argument("--verify-live", action="store_true", help="Read the current live release back without deploying.")
    args = parser.parse_args()
    version = validate_source()
    branch, commit = validate_git(require_main=args.deploy or bool(args.stage))
    require(not (args.stage and args.deploy), "Choose staged migration or combined deployment")
    require(not args.stage or args.browser_evidence is not None, "Release staging requires CUA evidence")
    run_checks(browser=args.browser or args.deploy or bool(args.stage), browser_evidence=args.browser_evidence)
    with tempfile.TemporaryDirectory(prefix="pmg-driver-release-") as temp:
        artifact = Path(temp)
        hashes = build_artifact(artifact)
        print(json.dumps({"buildId": version["buildId"], "branch": branch, "commit": commit, "hashes": hashes}, indent=2))
        if args.stage:
            require(not args.stage.exists(), "Stage destination already exists; preserve it and choose a fresh directory")
            validated = validate_browser_evidence(args.browser_evidence)
            require(all(hashes[name] == validated["sourceHashes"][name] for name in DEPLOY_FILES), "Staged artifact differs from tested CUA source")
            shutil.copytree(artifact, args.stage)
            (args.stage.parent / (args.stage.name + "-source-binding.json")).write_text(json.dumps({"commit": commit, "buildId": version["buildId"], "sourceHashes": {relative: sha256(PROJECT / relative) for relative in evidence_files()}, "artifactHashes": hashes}, indent=2) + "\n")
        if args.deploy:
            require("PMG_APP_STORE" not in (PROJECT / "worker/wrangler.toml").read_text(), "Transactional storage release requires --stage and verified index backfill before Pages; follow coordinated rollout plan")
            require(args.browser_evidence is not None, "Deployment requires CUA browser evidence")
            validated = validate_browser_evidence(args.browser_evidence)
            require(all(hashes[name] == validated["sourceHashes"][name] for name in DEPLOY_FILES), "Deployment artifact differs from tested CUA source")
            deploy(version, hashes, artifact, commit)
        elif args.verify_live:
            verify_live(version, hashes)
    print("RELEASE_GUARD_PASSED")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.CalledProcessError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"RELEASE_GUARD_FAILED: {exc}", file=sys.stderr)
        raise SystemExit(2)
