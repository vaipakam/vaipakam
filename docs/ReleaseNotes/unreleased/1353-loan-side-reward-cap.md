## Thread — Loan-side interaction-reward cap (M2 PR-5c) (PR #<n>)

Adds the third piece of the VPFI fee package the spec supersession (#1350)
described: the **loan-side interaction-reward cap**. Where the Full tariff
(#1347) makes a party *absorb* a fee-native `C*` at loan origination, this card
uses that same notional `C*` to **bound how much interaction-reward VPFI a
single loan can emit per side** — replacing the old #1008 "VPFI-per-ETH-of-
interest" ratio cap that scaled with loan volume and let a thin, high-share
book over-reward.

The new ceiling is a per-`(loanId, side)` **lifetime budget**, priced off the
`C*` stamped at open:

- `loanSideRewardCapOpen = ½ × C* × (1 − m_reward)`, cached at origination.
  `m_reward` is a new governable haircut (`setRewardHaircutBps`, default **2%**,
  bounded 0–20%), **snapshotted** at open so a later retune can't rewrite an
  open loan's ceiling.
- At claim the ceiling **prorates by rewarded days**:
  `loanSideRewardCapEff = loanSideRewardCapOpen × min(rewardedDays, openDays) /
  openDays`. An early-closed loan (few rewarded days) earns proportionally less;
  a lender sale splits the reward entry but the day count and paid budget are
  **shared** across both halves, so a sale can't reset the budget.
- Each side (lender / borrower) owns the per-side half of the tariff-linked
  ceiling; the 50/50 pool split is unchanged and the daily-pool share still runs
  first — the cap only ever **lowers** a payout, never raises it.
- The cap governs only the **armed (post-`D*`) portion** of a reward entry, so a
  loan whose reward window spans the cutover keeps its pre-`D*` days under the
  legacy #1008 regime and has only its post-`D*` slice loan-side-capped.

A loan that carries no `C*` **stamp** (`openDays == 0`) — a mirror-chain loan, a
dark-era pre-enable loan, or any pre-cutover loan — is **not** zeroed: the cap
simply **does not apply** and it earns normally. (A **stamped** loan whose `C*` /
ceiling merely rounds to 0 — a genuinely-priced dust loan — IS still capped; the
skip keys on the `openDays` stamp marker, always ≥ 1 when stamped, not on
`cStarOpen` or the rounded ceiling.) True reward-**ineligibility** (a
canonical origination whose list LIF cannot be priced) is enforced **upstream** by
not creating reward entries at all — never by zeroing a payout at the cap. This is
the anti-farming rule stated correctly: an unpriced loan draws nothing because it
has no reward entries, not because a live loan's earned reward is retroactively
voided.

Because that skip leaves an unstamped loan uncapped once #1008 also retires on
armed days, arming `D*` has a **precondition** (the `cStar` **backfill gate**):
every reward-eligible **canonical** loan must be stamped before `D*` arms — which
holds from genesis on a fresh (pre-live) deploy, and is backfilled first on a
post-launch cutover. Mirror-chain loans are bounded by the D1 share cap (PR-2) on
their local claim, not the loan-side cap. The arming-time enforcement is a
deploy-assert (PR-9).

The whole cap is gated on the **joint cutover `D*`** (the ShareOfPool arming):
while `D*` is unarmed — the state of every current deploy — the cap is a
complete no-op and the pre-cutover #1008 regime is untouched, so this ships
**dark**. `D*` is armed later, jointly with the D1 share cap (PR-2 #1351) and
the settlement sweep (PR-6 #1354); the master `feeEntitlementEnabled` switch
stays forbidden until all three are live. On a fresh (pre-live) deploy every
loan stamps its notional `C*` from genesis, so there is no backfill step. The
lender-Full settlement discount (+10% yield-fee) and the frontend tariff quote
remain separate later cards (PR-6 #1354 / PR-8 #1355). Closes #1353.
