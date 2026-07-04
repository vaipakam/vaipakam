## Thread — alpha02 testnet-review findings remediation (#988)

Five fixes from the 2026-07-03/04 live-testnet review, all in the
alpha02 frontend.

**Terminal loans can no longer offer a live Repay (OBS-2).** The
position page previously trusted the indexer row for its action gate,
so with a lagging indexer a loan that had already been liquidated
on-chain still showed a working "Repay this loan" button (the write
would fail confusingly). The page now takes one cheap live status read
and reconciles the row where it is built — badge, action, cards, and
receipts all inherit the on-chain truth, always overriding toward the
more-settled state, with a banner explaining that the lists are
catching up. The repay submit path independently re-checks the live
status and stops with a clear message before any approval or wallet
prompt when the loan is no longer repayable.

**"You need more X" now says how much more (F-005).** Everywhere the
shortfall is computable — the pre-submit balance gate, the eligibility
checklist, and the add-collateral / partial-repay inputs — the message
states the missing amount (e.g. "about 0.002 more WETH") instead of
just naming the asset.

**Secondary-market buyers now see their claims (#958 parity).** The
Claim Center's candidate discovery unions the wallet's indexed loans
with the on-chain enumeration of position NFTs the wallet currently
holds, so a claim attached to a purchased position is found even though
the wallet was never the loan's original party. Chain-discovered loans
are confirmed by the same live ownership + claimability checks as
indexed ones.

**An empty market is now distinguishable from a stale one (F-003).**
The Offer Book, guided matching, and rental browse surfaces show a
"this list last updated N ago and may be behind" note whenever the
indexer's ingest cursor has positively stalled (reusing the freshness
stamp the stats endpoint already serves) — so "no offers right now" is
never confidently rendered from a stalled snapshot. Unknown freshness
shows nothing rather than crying wolf.

**VPFI "warming up" names its target.** While the time-weighted
discount catches up to a fresh deposit, the status card now states the
qualified tier's discount (and the current effective figure when
non-zero) instead of a vague "higher tier".

Also verified with no code change needed: no protocol read path can
fall back to a public RPC endpoint when the per-chain RPC env vars are
set (OBS-1 — the only public fallbacks are the env-unset defaults and
the deliberate mainnet ENS display transport), and the post-write
replica race (F-002) is judged acceptably mitigated by the per-block
live-sync layer plus the submit-time live re-reads every money flow
already performs.
