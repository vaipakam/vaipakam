## Off-chain backups — transient storage faults are retried (PR #3052)

The backup watcher's first runs found three gaps in the nightly backups: no
backup at all on October 1 (so no October monthly either), and two Sunday
dailies, October 18 and 25, written without their manifest. The October 25
log shows the cause: Backblaze answered the manifest upload with a one-off
"internal incident" error, and the nightly gave up on the first failure. The
watcher's own first real run hit the same kind of error part-way through.

The nightly now retries such faults. It tries each upload up to three times,
with a short pause, when the failure is a network error, throttling or a
server-side fault, and stops at once on a refusal. The watcher retries its
reads the same way, but never repeats a ledger upload within a run: a failed
upload is indeterminate (it may have been stored, or may still land), and a
second one could leave a second locked version that the watcher itself would
read as tampering. Instead the run still judges that archive from what it
computed, says in its summary that it was left to the next run, and the next
day's run, once the first request has long settled, records it if its own
listing shows it did not land. An archive that stays out of the ledger for
more than two days after the ledger could first have recorded it pages.

The nightly's key cannot list the bucket, so it cannot make that same check.
If Backblaze ever stores an upload and still reports an error, the retry
leaves a second copy of that name; the watcher then reports the name as
ambiguous rather than letting it pass unnoticed.

Advances #1473. The three gaps already recorded stay in issue #3048 until
they are acknowledged: the missing October 1 backup and the two missing
manifests cannot be recreated after the fact.

> Caveat: the October 1 and October 18 logs are past their retention, so their cause is inferred from October 25's, not observed.
