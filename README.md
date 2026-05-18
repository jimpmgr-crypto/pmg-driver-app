# PMG Driver App

John Bowman trial mode is available at `/john/` on the prototype host, or by opening this app with `?driver=john`.

Approved live-write phase: `LIVE_WRITE = true` in `index.html` after Jim's 2026-05-11 approval for John Bowman. Start/In Transit is local + PMG worker status only and must not write to Haultech. Final completion still attempts `/ht/complete` only after supplied proof is protected, and `/ht/mpod` remains best-effort with worker fallback.

Safety remains: worker KV/local queue capture stays on as an audit trail and fallback. Started status is merged back into live job refreshes so the card keeps showing IN TRANSIT while Photo/sign/Complete stays available. Proof completion is only marked `written` after live complete and all supplied proof upload attempts finish. If photo/signature upload falls back or fails, the queue state and toast report that clearly. Driver-added rows, problems, and unmapped/cached jobs still queue for office review rather than inventing live Haultech records.
