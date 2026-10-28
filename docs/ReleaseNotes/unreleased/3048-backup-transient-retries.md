## Off-chain backups — transient storage faults are retried (PR #<n>)

The backup watcher's first runs found three gaps in the nightly backups: no
backup at all on October 1 (so no October monthly either), and two Sunday
dailies, October 18 and 25, written without their manifest. The October 25
log shows the cause: Backblaze answered the manifest upload with a one-off
"internal incident" error, and the nightly gave up on the first failure. The
watcher's own first real run hit the same kind of error part-way through.

Both now retry such faults. The nightly tries each upload up to three times,
with a short pause, when the failure is a network error, throttling or a
server-side fault, and stops at once on a refusal. The watcher does the same
for its reads, and for its ledger uploads it first lists the name before a
retry: if the earlier attempt in fact landed, with these exact bytes, that is
taken as the upload, so a retry never leaves a second version that the
watcher itself would read as tampering.

The nightly's key cannot list the bucket, so it cannot make that same check.
If Backblaze ever stores an upload and still reports an error, the retry
leaves a second copy of that name; the watcher then reports the name as
ambiguous rather than letting it pass unnoticed.

Advances #1473. The three gaps already recorded stay in issue #3048 until
they are acknowledged: the missing October 1 backup and the two missing
manifests cannot be recreated after the fact.

> Caveat: the October 1 and October 18 logs are past their retention, so their cause is inferred from October 25's, not observed.
