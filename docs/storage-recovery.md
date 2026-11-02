# Driver storage recovery

Repair candidate: `20261102-driver-storage-recovery-r1`.

The completion audit is saved in localStorage before proof or HaulTech writes.
A quota exception here prevents completion, while the old toast disappears.
Old daily plans have no retention limit. Device storage contents still require
phone evidence; a quota failure does not prove which records occupy the space.

`driver-storage.js` checks headroom on startup and before sign-off. It copies
eligible ordinary past-day job caches to IndexedDB database
`pmg-driver-cache-archive-v1`, store `snapshots`. Each record contains a unique
ID, original key, exact raw JSON and archive time. A committed copy and separate
readback must match before removing the unchanged localStorage original.
Office recovery can read these records using IndexedDB; there is no remote
upload, deletion of the archive, or automatic history replay.

Today/future, unknown/malformed records, driver-added/proof-bearing rows,
walkarounds/drafts, all event/writeback queues and retry journals stay in place.
Dates with pending writes or backup journals are excluded. If only protected
data remains, recovery fails visibly and retains the open proof form. If the
browser blocks storage or the archive fails, do not bypass this protection.

All six driver routes use the same module and completion logic. Service-worker
shell caching includes the new module. Plant, Yard, HaulTech, Fleet, pricing,
server receipts and external evidence consumers are unchanged. OpenCore uses
the existing investigation task packet/report; no new recurring process.

## Already-open affected phone

Once the recovery page is approved and published, open
`https://pmg-driver-app.pages.dev/storage-recovery.html` in the same browser/store
without closing the original job form. Tap **Free space safely**, then return
to the original form and retry. This route can repair storage for old running
code without refreshing the form. A different browser or isolated installed
app store may not share storage; healthy-space output is not proof that John's
store was repaired. Never clear browser/app data or force reload mid-signature.

Automatic updates still defer during sign/photo/walkaround forms. Deployment
does not prove adoption or successful sign-off on John's phone. Require his
retry plus exact live completion/proof readback before closing the incident.

## Regression checks

- `node tests/test_driver_storage.js`: quota, commit/readback failure, pending
  preservation, concurrent edit/pending state, interrupted archive and retry.
- `node tests/test_completion_identity.js`: exact job, double tap, held form,
  no completion on storage failure and secondary-error reporting.
- `npm run test:unit`: existing proof, pricing, diary, queue and route checks.
- CUA Chrome: `tests/storage_recovery_browser.html` on a new localhost origin.
  Uses synthetic data only, reproduces actual quota, verifies native IndexedDB
  after close/reopen, retains protected keys and retries the original write.

Release allowlist includes the new module and recovery HTML. Never publish
tests or the localhost fixture. Use the existing release guard and authority.
