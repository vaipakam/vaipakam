### Pull requests no longer stall silently while everything looks fine

Getting a change merged here involves waiting: an automated reviewer answers a
few minutes after it is asked, the test suite finishes on its own schedule, and
the main line of development moves underneath long-lived branches. None of those
announces itself. When the person driving a change steps away, it simply stops —
and the stop is invisible, because the change still shows a clean review and
passing checks.

Two examples from this week. One change sat for twenty-three hours because a
request for review was posted and never answered; nothing was wrong with it and
nobody knew it was waiting. Another sat with a one-line conflict in a shared
configuration file — two changes had each added a check to the same list — and
looked entirely healthy until someone tried to merge it.

A scheduled agent now sweeps the open changes every fifteen minutes. It resolves
mechanical conflicts against the main line and verifies the result, diagnoses and
fixes failing checks, notices when a review request has gone unanswered and asks
again, and works through review findings — fixing them, disputing them with
evidence, or filing follow-up work and linking it. Follow-ups get recorded rather
than remembered, which is the part that was quietly failing before.

**It will not merge anything on its own initiative.** Merging is the one step
that cannot be undone, so it requires a per-change consent flag that a person
applies. Without that flag the sweep still does everything else and leaves the
change ready, saying so. With it, the change merges once its checks are green and
every review conversation is settled. Granting the agent broader latitude is a
one-line change, deliberately left as a decision rather than a default.

Two smaller notes on why it is built this way. It polls on a timer rather than
subscribing to notifications, because the notification stream is dominated by
routine deployment messages and consuming it exhausted the very quota needed to
settle review conversations. And it runs as a repository-level scheduled job
rather than inside someone's session, because a timer that lives in a terminal
dies with the terminal — which is the failure this is meant to prevent, not
reproduce.

The sweep can also be run on demand, optionally pointed at a single change, when
waiting for the next tick is not worth it.

### And something watching the watcher

The sweep runs on two timers that back each other up, but both are the same
mechanism on the same job — so neither helps if the job is disabled, or is
failing on every attempt. Both of those go wrong quietly, and, more awkwardly,
both look exactly like the sweep running and finding nothing to do. The thing
built to stop work stalling invisibly would itself stall invisibly.

A second, much cheaper check now runs a few times a day and asks one question:
when did the sweep last finish successfully? If the answer is longer ago than it
should be, it raises an alarm on the internal operations channel — the same one
already used for backup failures and cross-chain drift, kept separate from any
user-facing channel on purpose. If that channel is not configured, the check
fails loudly rather than passing quietly, because a watchdog that cannot raise an
alarm is not a quieter watchdog, it is a broken one.

That check is itself on a timer and so is subject to the same inactivity rule.
That is not worth chasing further: a repository quiet enough to trip it has
nobody waiting on changes anyway. The failure worth catching is a broken sweep
while work is actively going on, and this catches that.
