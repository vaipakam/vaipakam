### #717 — defi staking-terminology excision (#687-B UI follow-up)

The on-chain `5% APR` staking yield was removed in #687-B (discount tiers and
interaction rewards were kept). This change finishes the job in the connected
app, where "stake / unstake / staking" language lingered even though vault-held
VPFI now only earns a fee-discount tier, never a yield.

What changed for users:

- The VPFI vault page, dashboard CTA, lender-discount card, token-card tooltip,
  navigation, and loan/activity timelines now say **deposit / withdraw / hold**
  instead of "stake / unstake / staking". The underlying action is unchanged —
  moving VPFI into or out of your vault to qualify for the fee-discount tier.
- Copy that implied a staking *yield* (e.g. an empty-state hint, a rewards
  summary heading) was removed or reworded; vault-held VPFI is described purely
  as lowering fees, not as earning interest.
- Two activity/timeline entries for events that no longer exist — the staking
  rewards claim (removed in #687-B) and the fixed-rate VPFI buy (removed in
  #687-A) — were dropped, since those events can never occur again.

Behind the scenes this also removed dead front-end and indexer code that
decoded those two retired events, and deleted the orphaned defi FAQ copy block
(the FAQ now lives only on the marketing site). Translations of the reworded
strings were dropped from the nine non-English bundles so they fall back to the
corrected English until a human re-translation pass (tracked separately).
