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


PROJECT = Path("/Users/bill/.openclaw/workspace/projects/pmg-driver-app").resolve()
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
    "manifest.json",
    "plant-manifest.json",
    "plant-seed.json",
    "plant.html",
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
    require(Path.cwd().resolve() == PROJECT, f"Run only from canonical project: {PROJECT}")
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
        require(branch == "main", f"production deploy requires main, not {branch!r}")
        run(["git", "fetch", "origin", "main"])
        require(output(["git", "rev-parse", "origin/main"]) == commit, "HEAD must be pushed to origin/main before deploy")
    return branch, commit


def run_checks(*, browser: bool) -> None:
    run(["python3", "-m", "py_compile", "tools/driver_release_guard.py", "tools/driver_app_runtime_check.py"])
    run(["node", "--check", "worker/index.js"])
    run(["node", "--check", "sw.js"])
    run(["npm", "run", "test:unit"])
    run(["npx", "wrangler", "deploy", "--dry-run"], cwd=PROJECT / "worker")
    if browser:
        run(["npm", "run", "test:browser"])
    run(["python3", "/Users/bill/.openclaw/workspace/scripts/pmg-app-lane-guard.py"])


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
    parser.add_argument("--deploy", action="store_true", help="Deploy worker and exact tested Pages artifact.")
    parser.add_argument("--verify-live", action="store_true", help="Read the current live release back without deploying.")
    args = parser.parse_args()
    version = validate_source()
    branch, commit = validate_git(require_main=args.deploy)
    run_checks(browser=args.browser or args.deploy)
    with tempfile.TemporaryDirectory(prefix="pmg-driver-release-") as temp:
        artifact = Path(temp)
        hashes = build_artifact(artifact)
        print(json.dumps({"buildId": version["buildId"], "branch": branch, "commit": commit, "hashes": hashes}, indent=2))
        if args.deploy:
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
