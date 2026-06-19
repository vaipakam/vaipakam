# Release Notes — 2026-06-18

Three PRs landed the outward-facing aggregator path and the first half of the
protocol backstop: the ERC-4626 aggregator lender-adapter (#398 v1.5), backstop
v0 Role A (#399, counterparty-of-last-resort), and real-principal KYC screening
on the aggregator adapter (#627).

## Thread — ERC-4626 aggregator lender-adapter (v1.5)

Yield aggregators (Yearn-style) can now supply capital to Vaipakam through a
standard **ERC-4626** vault interface and have it lent out continuously, with no
bespoke integration. This is the layer that lets external aggregated capital —
the kind that won't wire up a custom peer-to-peer order book but will route into
a standard deposit/withdraw vault — flow into the platform's lending.

**How it works.** Each aggregator is provisioned its own adapter: it deposits the
lending asset, the adapter places that capital behind a standing lending intent,
and the platform's keepers match it to borrowers and roll the returns back in to
compound — exactly the set-and-forget supply loop the standing-intent layer
already provides, now wrapped in the ERC-4626 face aggregators integrate against.
The aggregator's own depositors are pooled inside the aggregator, off-Vaipakam;
on Vaipakam each adapter holds exactly one party's capital.

**One adapter per aggregator, never a shared pool.** Because an ERC-4626 vault is
itself a share token, a single shared adapter would pool multiple aggregators
into one share token — the commingling the platform's no-commingling principle
forbids. So each aggregator gets its own adapter instance (its own share token),
deposits are restricted to that one authorized aggregator, and the shares are
non-transferable, so the single-party property holds at both the deposit and the
share layer.

**Conservative, honest valuation.** The adapter reports its value (the ERC-4626
share price) conservatively: idle capital plus outstanding loan principal marked
down by a governance-set per-asset haircut, with not-yet-collected interest
excluded until it is actually collected. Interest enters the value only when a
loan repays and its proceeds compound back into idle capital. Withdrawals are
limited to idle (un-lent) capital — capital out on live loans becomes
withdrawable as those loans mature. The intent is to keep the share price from
overstating value, protecting the aggregator's downstream depositors. One
documented edge remains conservative-*pending-claim*: between the moment a loan
defaults and the moment a keeper claims its recovery, the failed loan's principal
is still marked at face-minus-haircut, so if the realized loss exceeds the haircut
the value can briefly overstate until the claim realizes the write-down.
Aggregators are advised to run a keeper that promptly claims terminal loans and to
treat the reported value as conservative-pending-claim.

**Aggregator-controlled upgrades.** The adapter is upgradeable, but on the same
model as the per-user vault: governance publishes a new version, and each
aggregator chooses when to migrate its own adapter to it — no silent change to a
live integration. Governance can mandate a version floor only to force a critical
security fix (upgrade-or-halt). A principal-only wind-down lets an aggregator stop
new lending and exit, and a recovery path returns the proceeds of any loan that
resolved outside the normal auto-roll (e.g. a default) back into the adapter.

Part of #398 / the #401 hybrid intent/liquidity program (phase v1.5). Builds on
the standing-intent layer (#393); the offer-vs-intent capital isolation it relies
on was settled in #621.

### #399 — Treasury-seeded backstop, v0 Role A (counterparty-of-last-resort)

The platform now has an optional, protocol-funded backstop that can step in as the
lender when a borrower's offer would otherwise sit unmatched. It is governance-run,
funded only from treasury capital, and off by default behind two independent
kill-switches.

How it works for a borrower: when posting a borrow offer, the borrower can opt it
into backstop eligibility by setting a future deadline (which must be a genuine
interval after posting and before the offer expires). If no ordinary lender takes
the offer by that deadline — and the offer is still valid, unfilled, and backed by
liquid, oracle-priced collateral within the protocol's risk limits — anyone can
trigger the backstop to fund it from treasury at the backstop's posted terms. The
borrower gets last-resort liquidity; the backstop becomes the lender of record and
later recovers the repaid principal and interest back to the treasury.

Governance controls every parameter: a master pause and a separate Role-A switch
(both default off), per-asset capacity caps, the posted backstop rate, the
collateral types the backstop will accept, and the minimum wait before a backstop
fill can fire. The backstop holds its capital in its own isolated vault, never
commingled with ordinary user deposits, and only ever lends against the specific,
governance-vetted collateral assets it is configured for — a borrower cannot get
funded against an arbitrary or illiquid token.

This is the first half of the backstop. The liquidator-of-last-resort half (the
backstop buying out a stuck, thin-market liquidation to make a lender whole) is a
separate follow-up. Both remain off until governance explicitly enables and seeds
the backstop.

### #627 — Aggregator adapter screens its real principal's KYC

The ERC-4626 aggregator lender-adapter (#398) lends as the on-chain lender-of-record, so when a deploy enables KYC enforcement the protocol's threshold KYC check landed on the adapter rather than on the aggregator that actually controls the capital. The adapter now screens its real principal's KYC inside `matchLoan`, at the exact transaction value the accept path itself computes (a new public view exposes that valuation, so there's no risk of a re-derived value drifting from the protocol's own).

This has no effect on the retail product, where KYC enforcement is permanently off — the check short-circuits to "allowed" for every address, exactly like every other KYC call site. It matters only for the separate industrial-fork deploy that turns KYC on: there, an aggregator whose verification is missing or downgraded is blocked from originating new loans through the adapter, just as a direct lender would be. Completes the "screen the real principal" posture the adapter already applied to sanctions.
