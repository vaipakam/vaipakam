## Thread — alpha02: Rate-Desk hardcoded strings extracted and translated

The advanced Rate-Desk terminal was the last connected-app surface still
rendering English in every language, because a handful of its labels and
tooltips were hardcoded in the markup rather than routed through the copy
catalog. These were the occurrences the AST hardcoded-string detector
(#1365) had frozen in its baseline for the desk; this pass moves them into
the catalog, translates them, and empties that baseline.

The extracted strings: the tape panel's "Loading recent fills…" line and
its per-row tooltip (rate · loan # · status); the market-header last-fill
tooltip; the order-book mid-row ("mid …" with an optional " · spread …"
suffix, now two catalog pieces so the connector translates cleanly) and
its quoted-mid tooltip; the crossable-match band's pair tooltip (rate ·
offers # × #); the open-orders amend form's "Reading the offer's live
values…" line, its "Close" button, and the "bps stored on-chain" unit
hint; the signed-fill confirm's "Close" button; the positions row's
remaining-days ("N d left" / "N d overdue") and partial-repay marker; and
the order ticket's two security-check leg labels (loan asset / collateral),
which are display-only there, so localizing them carries no gate-recheck
hazard. The loan-id references in the desk history and positions rows now
reuse the shared "Loan #N" catalog entry instead of a second hardcoded
copy.

One dependency had to be resolved first: the recent-fills tape tooltip
shows the raw indexer loan-status word (active / repaid / defaulted /
liquidated / settled / settling / matched), which — unlike the position
and history badges that collapse status through the existing label helper —
had no translated vocabulary. A small `desk.loanStatus` map now localizes
each of those seven values, so the tape tooltip reads in the active
language like the rest of the desk.

Each new catalog key was translated across all nine active locales (zh,
ta, de, fr, es, ar, ja, ko, hi), reusing each locale's existing desk
terminology for recurring words like spread, mid, loan, and collateral,
and preserving every `{{placeholder}}` and the leading spaces on the
concatenated fragments. English output is byte-for-byte unchanged. With
these gone, the hardcoded-string detector's desk baseline is empty — only
the AppShell release-stage badge (a proper noun) and non-copy developer
diagnostics remain frozen — so the same strings cannot be reintroduced
untranslated. Scope is limited to `apps/alpha02`; no other app, package,
or contract was changed.
