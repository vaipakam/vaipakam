## Push readiness covers both senders (PR #<n>)

The app asks the agent whether Push can be sent before it offers the Push opt-in. Until now the agent could answer only for its own rail, the one that sends payment reminders. The risky-loan warnings come from the keeper, which signs with its own copy of the key on the keeper machine. So the Alerts card had to say its check covered payment reminders only, and suggest keeping another channel on for the warnings.

Each time its health-factor watcher runs, the keeper now writes one row to the shared database: whether its rail can send, and on which channel or why not. The row carries nothing about the key itself. The agent reads that row alongside its own rail and answers for the whole service:
- Push is available only when both rails can send on the same channel, because a user subscribes to one channel.
- If either rail is down, the answer names which rail and gives the reason.
- If the two rails post as different channels, the answer says so as a channel mismatch.

The app already drops its reminders-only caveat for a whole-service answer. A new Push opt-in is judged against the same answer.

The keeper's row is trusted for 15 minutes. If it is missing, unreadable or older than that, the agent knows nothing about the keeper's rail. It then answers for its own rail alone, scoped to it, which keeps the app's caveat, rather than borrowing its own answer for the keeper. A new shared table, `push_rail_status`, holds the row. It is additive, carries no chain id, and is cleared before a restore replay like other republished state. Closes #2667.
