## Thread — Health warnings start fresh for a withdrawn loan's number (PR #2655)

When the indexer finds that a loan it published never existed on chain (say,
its opening was undone by a chain reorganisation), it withdraws the record and
clears its own memory of the alerts sent for that loan number. The keeper keeps
a separate memory of which health-factor band it last warned each loan about,
in its own database, which the indexer cannot reach. That memory was only ever
cleared for loans that had ended, so a withdrawn loan's entry stayed forever.
If the chain then gave the same loan number to a real loan, owned by the same
wallet and sitting in the same health band, the keeper treated it as nothing
new and the owner's first warning never went out.

The keeper now also clears its memory of any loan number the indexer has
withdrawn under the current deployment, but only what it remembered before the
withdrawal. Anything it learned afterwards is about the real loan and is kept,
so that loan's warnings follow their normal rules and are never repeated on
every check. A warning the keeper was about to post for a loan that the
indexer withdraws in the same moment is no longer posted after the withdrawal,
so it cannot bring back an alert for a loan that never existed or take the
place of the real loan's first warning that day. A withdrawal recorded under an earlier deployment of the
contracts is ignored. The health-factor check also now hands the database
each list of loans as a single value, so a busy check covering thousands of
loans can no longer run past the database's limit on values per request and
stop sending warnings. Closes #2638.
