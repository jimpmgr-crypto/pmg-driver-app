# PMG Driver App

John Bowman trial mode is available at `/john/` on the prototype host, or by opening this app with `?driver=john`. Richard Whittaker's personal driver route is `/richard/`; his PIN login still opens the all-driver manager view, which now includes an `Open my driver app` shortcut on Richard's own section. Paul Locket's personal route is `/paul/`; it uses his live Haultech driver identity and leaves the normal vehicle selector available so he can move between the concrete and other wagons.

Plant Information Hub:

- Tony mechanic view opens at `/tony`; `/plant` is kept as a compatibility route for the same Tony-only mechanic app.
- Jim's wider plant/HGV/driver/cost overview is a separate app and consumes this structured plant data instead of adding another mechanic entry point.
- Katie's workbook feed is imported with `tools/plant_import.py`; only plant tabs plus the named plant/tool sheets are read.
- Tony's plant search can be filtered by group: Diggers, Dumpers, Small plant, Tools, or Other. The worker derives this from the live asset name/type so weekly Katie imports and Jim's overview stay on the same grouping.
- Current schedule rows marked as unused/spare with no machine identity are skipped, so plant numbers such as 11, 20, 26 and 66 do not show as needing first setup.
- Tony history and filter/parts rows show what was done, the supplier/source where useful and the reference number where useful, but not prices.
- Tony's plant service rule is 500 hours or 12 months, whichever comes first. Known last-service dates produce annual due dates in the snapshot, and new Tony service entries default the next due date to 12 months after the service date. Tony can still choose 250, 500, 750 or 1000 hours manually for the next service interval.
- Tony can log `Service schedule review` when a machine is time-overdue but the real hours show a full service is not due yet. This records an inspection/review, not a full service, but applies any next due date/hours Tony enters so the overdue alert moves correctly.
- Tony can log `Pre / post hire check` from the service type dropdown. This records a quick hire/job check as an inspection and keeps comments/parts available. It does not reset the 500-hour/12-month service schedule unless Tony explicitly enters new next due date or next due hours values.
- Tony sees simple in-app service alerts when a machine is overdue or due in 30 days, 15 days or 2 days. Once Tony logs a service and the next due date moves forward, the alert drops away automatically.
- Tony explicitly marks a current service alert as seen. Jim's Fleet Live overview shows `Waiting for Tony` or the recorded `Seen by Tony` time; acknowledgements are tied to the current due target and alert band so stale acknowledgements do not carry into a changed or escalated alert.
- Tony can enable Home Screen app push notifications from the mechanic app. The worker checks around 8am UK time and only sends a phone notification when a plant service alert is actually due/overdue.
- The worker stores the imported snapshot separately from Tony's live service entries, so a weekly import can refresh Katie's rows without wiping mechanic records.
- Run a dry check with `python3 tools/plant_import.py --dry-run`.
- Refresh the local seed with `python3 tools/plant_import.py --out plant-seed.json`.
- Push a weekly import with `python3 tools/plant_import.py --push --api-key <worker-key>`.
- Pending mechanic evidence for the SharePoint writer is available from `/plant/sharepoint-export`; confirmed evidence links can be attached with `/plant/evidence-links`.
- Stage/upload Tony service evidence with `python3 tools/plant_sharepoint_sync.py`.
- Test the evidence pack writer without live upload with `python3 tools/plant_sharepoint_sync.py --self-test --skip-live-upload --skip-worker-link --force --output-root /Users/bill/.openclaw/workspace/state/plant_service_sharepoint_sync/self-test-output`.
- Recurring automations:
  - `PMG Plant Weekly Workbook Import` refreshes Katie's workbook feed.
  - `PMG Plant Service SharePoint Sync` checks Tony service entries hourly and writes evidence packs back to `SHARED/Plant and Tool Service Records` when the live plant worker routes and SharePoint session are available.
- Worker production route: `/plant/import-snapshot`, `/plant/assets` and `/plant/sharepoint-export` are live on `pmg-driver-sync.jimpmgr.workers.dev`; still run `cd worker && wrangler deploy --dry-run` before future worker changes.
- Driver walkarounds require every round-the-wagon photo (plus the trailer/coupling photo when a trailer is selected), all daily checks and any required live Fleet torque confirmation. Driver signature remains optional.
- Walkaround photos use one in-app rear-camera session that advances through the required views without leaving the installed app. `Use phone camera instead` is the fallback when inline camera permission/capability is unavailable; its file input is reset before every capture so repeated Android camera filenames still fire correctly.
- Driver-added day-sheet rows require both a reference/name/ticket number and useful office/invoicing notes; both are carried into the Haultech writeback path.
- Production Driver App releases must use `python3 tools/driver_release_guard.py --browser --deploy` from this canonical project on a clean, pushed `main` branch. The guard builds a temporary allow-listed artifact, deploys the worker and frontend with the real Git commit, then reads the live files and all named driver routes back. Never deploy a `work`, `scratch` or `tmp` copy directly.
- Known-good rollback baseline before reliability v66: Git tag `driver-app-v65-known-good`.
- Post-deploy order:
  - `cd /Users/bill/.openclaw/workspace/projects/pmg-driver-app/worker && wrangler deploy`
  - `cd /Users/bill/.openclaw/workspace/projects/pmg-driver-app && python3 tools/plant_import.py --check-worker --api-key "$PMG_DRIVER_SYNC_KEY"`
  - After any driver-app/Haultech change, run `python3 tools/driver_app_post_change_check.py --date YYYY-MM-DD --expected-build <app-version-buildId>` and do not call the change complete until it passes.
  - `python3 tools/plant_import.py --push --api-key "$PMG_DRIVER_SYNC_KEY"`
  - `python3 tools/plant_sharepoint_sync.py --check-worker`
  - `python3 tools/plant_sharepoint_sync.py`

Approved live-write phase: `LIVE_WRITE = true` in `index.html` after Jim's 2026-05-11 approval for John Bowman. Start/In Transit is local + PMG worker status only and must not write to Haultech. Final completion still attempts `/ht/complete` only after supplied proof is protected, and `/ht/mpod` remains best-effort with worker fallback.

Safety remains: worker KV/local queue capture stays on as an audit trail and fallback. Started status is merged back into live job refreshes so the card keeps showing IN TRANSIT while Photo/sign/Complete stays available. Proof completion is only marked `written` after live complete and all supplied proof upload attempts finish. If photo/signature upload falls back or fails, the queue state and toast report that clearly. Driver-added rows, problems, and unmapped/cached jobs still queue for office review rather than inventing live Haultech records.
