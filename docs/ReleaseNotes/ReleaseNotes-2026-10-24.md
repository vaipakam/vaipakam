# Release Notes — 2026-10-24

A short day. The keeper machine no longer builds the keeper itself: CI builds and attests each bundle, and the machine only verifies and installs it. Notification billing now needs a user's on-chain consent before any charge, and it screens the payer against the sanctions list. A governance batch locks the vault template and guards the deploy admin. A fork check of the priority-routing perk on BNB Testnet passed, and it turned up an unrecorded admin write that had priced the perk there on 2026-10-19; the records now say so. No credit was ever bought on BNB.

## Thread — BNB Testnet's priority-routing perk: the fork check, and a correction to the record (PR #2719)

The fork check that proves the priority-routing perk works against a deployed Diamond now has a BNB Testnet cell, alongside Base Sepolia and Arbitrum Sepolia. It uses the WETH stand-in and the mock liquid token that the 2026-10-22 testnet mocks priced. On 2026-10-23 it passed against a fork of BNB's live Diamond: a fill the solver's capacity covers is charged to the solver, fills it refuses are refused by name, and a fill that capacity would refuse goes through on exactly one of the intent owner's credits.

Running it turned up a correction. Every record said perk 1 was still unpriced on BNB: the deployment ledger, the perk's design document and the BNB mocks note. It was not. An admin write priced it at 2 VPFI per credit on 2026-10-19 at 13:29 UTC, the same price as the other two testnets, and nothing recorded it. Unlike Base and Arbitrum, no fork check preceded it, and until the mocks arrived no lender intent could be filled on BNB, so a credit bought there in that window could not have been used. None was bought: no purchase event appears on BNB's Diamond. The ledger now records the arming transaction, and the design document and the mocks note say what happened. Nothing on-chain changed in this PR.

Closes #2641.

_Committed 2026-10-24 00:07 UTC (a9cae8ad7)._
<!-- assembled-fragment: 2641-bnb-perk-fork-cell.md sha256=e9b80ab5e3de39114748cee3f1d17dee26fee13d7c370a55faf6be49bea7aefb -->

## Keeper — the keeper machine no longer builds; CI builds and attests each bundle (PR #2722)

The always-on keeper machine used to build every change to the keeper
itself. On that small machine (about 1 GB of memory, two shared CPUs on a
burstable shape), the late remittance check missed its read deadline in
about a third of the ticks that ran during a build, against 0.3% outside
one. Earlier fixes (building only when the build's source changed, lower
priority for the build, memory protection for the keeper) cut the number of
builds and the keeper's swapping, but not the misses. A measurement during a
build showed why: the build used little CPU itself, but the hypervisor took
about half of the machine's CPU time and the machine swapped hard enough to
stall disk access a third of the time. Priorities inside the machine cannot
win back time the host does not give it.

Now a GitHub Actions workflow builds the keeper bundle once for each change
of its build source, from `main` only, and publishes it with a signed build
provenance attestation to a `keeper-host` prerelease. The machine downloads
the bundle named by its commit's build-source digest. It installs the bundle
only after the GitHub CLI has verified the attestation. The attestation must
be signed for this repository's workflow, run on `main`, on a GitHub-hosted
runner, over exactly those bytes. The commit it names as the source must be
on `main` and give the build the same source. The machine then runs the
bundle's load check on its own Node. Uploading a release asset therefore
cannot change what the keeper runs; merging to `main` still does, as before.
The build job runs third-party install scripts with no credential in reach,
and a separate job that runs no repository code does the signing.

Operator-visible changes: the machine now follows `main` only (the
`KEEPER_DEPLOY_BRANCH` choice is gone, because CI builds `main` only, and an
unmerged recovery branch must be merged before the machine can run it). The
install script now also installs the GitHub CLI from GitHub's apt
repository, with its keyring checked against a pinned SHA-256, so it must be
re-run once on the existing machine after this change deploys. Until then
the machine keeps the keeper it is running and says the verifier is missing.
After a merge that changes the keeper, the machine waits a few minutes for
CI to publish the bundle and logs once that it is waiting.

The build-source digest now ignores permission bits beyond git's own
executable bit. Before, it read the modes of the extracted export, which
differ between root (the keeper machine) and any other account (the CI
runner), so the two sides named the same source differently and the machine
would never have found CI's bundle. The first CI run showed it; a test now
digests under several umasks and archive modes and requires one answer.

Refs #2651.

_Committed 2026-10-24 03:19 UTC (f8d6c4f3f)._
<!-- assembled-fragment: 2651-keeper-built-in-ci.md sha256=f3a53323477d1e1b152aec1f95af3d4fe53e1fe4e57f5a3d01063d99bda99f4d -->

## Notification billing — users must consent on-chain before they can be charged (PR #2768)

Before this change, the paid-notification fee could be taken from any loan party's vault. The bot holding the notification-billing role chose who to charge, and whether a user had opted into paid alerts was recorded only off-chain. The contract also never checked whether the loan was still open. A leaked billing key could therefore charge the fee once to every party of every loan ever opened, including users who never agreed to pay.

Each wallet now records its own consent on-chain: the most VPFI it agrees to pay per loan side. It can lower that or withdraw it at any time, and withdrawing works even while the protocol is paused. Nobody else can set it, the billing role included. The billing entry point now refuses, before anything moves, to charge a wallet that has not consented, a wallet whose cap is below the fee configured at that moment (agreeing to a lower fee is not agreement to a later, higher one), or a loan that is no longer active. A consent above the protocol's fee ceiling is refused rather than stored. Consenting at the ceiling accepts any fee governance can set. A retry for a loan side that was already billed is still a silent no-op. Anyone can read a wallet's consent and whether it covers the current fee. A leaked billing key can now at most charge early: only a wallet that agreed to pay, no more than it agreed to, once per side of an open loan.

The change applies to fresh deploys only. Nothing in the off-chain services calls the billing entry point today, so no bot change is needed now. Whichever service starts billing must read the consent, and the app must collect it when a user turns on paid alerts. That work is tracked in #2723. Closes #2721.

_Committed 2026-10-24 04:57 UTC (d278e7725)._
<!-- assembled-fragment: 2721-notification-billing-consent.md sha256=59b6ad2e7c906662cf97f467deb64133eb15b5a9f69ec463712a5143117bf95b -->

## Governance gates — notification billing screens the payer (PR #2774)

Charging a wallet for paid notifications now checks the payer against the sanctions oracle explicitly, before any fee leaves the vault. Before this change the check happened only indirectly, inside the vault withdrawal, and it let the charge through while the oracle could not be read. The rule is now stated where the fee is charged:
- With no oracle configured, there is no screen.
- A payer the oracle flags is refused by name.
- While the oracle cannot be read, every bill is refused instead of charging a wallet nobody could screen.

A flagged wallet's vault is frozen, not seized, and the payer's own consent to be billed does not change that. A refused bill moves nothing and leaves the side unbilled, so the billing role can retry once the wallet is de-listed or the oracle answers again. Screening is per payer, so a flagged counterparty never stops the clean side of the same loan from being billed. A side that was already billed stays a harmless no-op.

Paid-notification billing now has a facet of its own. The new screen pushed the loan facet, which hosted the charge, past the contract size limit. Billing a notification is not loan origination, so the charge moved off the loan facet and the consent setter and reader moved off the profile facet. Both now sit together in a notification-fee facet, where the consent's only reader lives beside its only writer. The function signatures are unchanged. The all-facets refresh moves the routes on its own. The curated refresh carries the new facet as well, so it can never leave billing on the old loan-facet code.

This also corrects a code comment added in #2768 that said the bill does not screen the payer. The sanctions action matrix gains a row for notification billing.

Closes #2769.

_Committed 2026-10-24 07:53 UTC (90d579fc7)._
<!-- assembled-fragment: 2769-notification-billing-sanctions-screen.md sha256=9226f75d4e8e1a31807c04a5db52cc4577d603d48c9fc2e61ad68043e08380c2 -->

## Governance — vault template lock, deploy admin guard, reachable vault-version bar (PR #2720)

The shared vault implementation now locks its own initializer when it is
deployed. Only the per-user vault proxies are ever initialized, so nobody can
call `initialize` on an implementation contract and make themselves its owner,
whatever path deployed it. Before, this depended on every deployer
remembering to initialize the template in the same transaction, and the
upgrade path only checked that the new implementation had code. The factory
and the upgrade script no longer initialize the template, since there is
nothing to initialize (#905).

The Diamond deploy now checks the admin address before it deploys anything.
The deploy hands every role and the Diamond's ownership to that address and
then renounces everything from the deployer, so a wrong address used to brick
the new Diamond. It now refuses the zero address, an admin address that is not
the address of the admin key the operator supplied, and, on a production
chain, an admin equal to the deployer key. The deployment runbook's stale
advice to set the admin address to the Timelock is corrected: the deploy-time
admin is the hot admin key, and the handover phase moves its roles to the
Timelock later (#947).

The mandatory vault version can no longer be set above the current vault
version. A user clears the bar by upgrading their own vault, which brings it
to the current version and no further, so a higher bar blocked every existing
vault with no way out until an admin acted again. Every change to the bar now
emits an event naming the old and new values (#2363).

Closes #905. Closes #947. Closes #2363.

_Committed 2026-10-24 01:42 UTC (6374b30c4)._
<!-- assembled-fragment: 905-947-2363-vault-and-deploy-hardening.md sha256=51fa2b125d5fb9530feed1a9fd3db382b1e267b5b61acf6f9c61ffeb40bb110e -->
