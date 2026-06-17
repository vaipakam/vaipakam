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
