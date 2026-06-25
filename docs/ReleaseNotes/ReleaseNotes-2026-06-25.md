# Release Notes — 2026-06-25

This release closes out the **anti-phishing + progressive risk access** security
epic (#670 → #662 → #671) — the platform's largest defensive arc to date. It moves
the protocol from a single hardcodable "I agree" consent to a layered, self-
sovereign risk model: acceptance is bound to the exact offer terms (#662); each
vault carries a progressive risk tier (BlueChipOnly → BroadLiquid → IlliquidCustom)
with per-pair consent for illiquid assets, enforced at both creation and accept and
re-checked against the live state of both parties (#671 foundation #727 + phase-2
#728, incl. the optional strict mode for mid-tier acknowledgements); the
acknowledgement that lets an acceptance stand in for a standing illiquid consent is
anchored to an **unguessable, commit-revealed** risk-terms secret so it can't be
pre-signed for a future terms version (#730), and the same unguessable anchor now
binds the relayed (gasless) self-sovereign grants too (#737). The reference dapp
gained the matching surface — an acknowledgement-aware accept preview, in-place tier
re-affirmation, and the strict-mode toggle with in-flow per-pair acknowledgement
recording (#735).

The whole mechanism ships **off by default** behind `riskAccessGateEnabled`, so a
fresh deployment behaves exactly as before. Enabling it on any network is a
governance action with a hard precondition — a revealed risk-terms anchor must exist
first — documented in the Governance Runbook ("Enabling progressive risk access").

# Anti-phishing: offer acceptance is now bound to the exact terms (#662)

Accepting an offer used to commit your wallet to nothing more than an opaque
offer id and a single "I agree" checkbox. A malicious clone of the app could
therefore get you to sign a perfectly valid acceptance whose wallet prompt told
you nothing about what you were actually agreeing to — and, on the illiquid-asset
path where the usual loan-to-value safety check is intentionally skipped, drain
you with a worthless dummy token.

From now on, accepting an offer requires a typed, wallet-rendered confirmation of
the **actual economic terms**. Your wallet shows — and you sign — the real lend
and collateral assets, amounts, rate, duration, the specific position a sale or
offset accept will buy or close, and (when a leg has no price oracle) the exact
illiquid asset you are acknowledging. The contract then checks, before any value
moves, that what you signed matches the offer on-chain to the letter; if anything
differs it refuses the acceptance. A cloned front-end can no longer swap the
terms between what you see and what executes, and it can no longer hide a
worthless asset behind a blanket consent.

This is a one-time signing step that the app fills in for you from the offer you
are viewing — there is still just one thing to acknowledge, now backed by a
prompt that actually describes the deal. The keeper-driven matching path (which
pairs two already-authored offers, with no acceptor to phish) is unaffected.

This is the foundation the upcoming progressive risk-access tiers build on.

## Thread — Progressive risk access: per-vault tiers + create-time gate (PR #<n>)

Foundation for #671. Every vault now carries a **risk-access tier** — a
self-chosen ceiling on how risky the assets it transacts may be. There are
three tiers: **BlueChipOnly** (the zero-init default for every vault),
**BroadLiquid**, and **IlliquidCustom**. A vault opts UP a tier itself — never
by accident and never by an admin allow-list — either directly from its own
wallet or via a gasless EIP-712 signature a relayer can forward (so a
smart-contract wallet can opt up too). Lowering a tier is always immediate;
raising one is subject to an optional opt-up cooldown (default zero).

The tier a given offer requires is **derived entirely on-chain** from the same
liquidity-depth machinery the LTV/health-factor system already uses — there is
no governance list of "approved assets". An asset is treated as blue-chip if it
is the numeraire basket (WETH or one of the configured quote assets) or if it
independently earns the deepest on-chain liquidity tier; a merely-liquid asset
just needs the vault opted up to BroadLiquid (no per-pair step — the quantitative
LTV/health-factor check still applies); an illiquid or unpriced asset needs
explicit per-pair consent. The riskier of an offer's two legs governs, and an
NFT rental is classified off the value-bearing prepayment token rather than the
rented NFT. The whole surface re-locks itself with zero writes when governance
bumps a global terms version: a tier or consent only counts while its
per-vault version anchor is still current.

The gate is enforced at the **offer-creation chokepoint** that every create
path shares, so an under-tiered creator's offer is refused before it is posted.
The protocol-authored lender-sale-vehicle offer is exempt, since its risk belongs
to the exiting lender and was already gated at the original loan. An
offset/obligation-transfer offer is NOT exempt — it forms a new position for the
initiating user, so it is gated on that user's tier like any other create. The entire feature is behind an off-by-default
master kill-switch (`setRiskAccessGateEnabled`), exactly like the depth-tiered-LTV
rollout: a fresh deploy behaves identically to before, and each chain flips the
gate on only after its own liquidity census.

This is the first of several #671 PRs. Still to come: re-asserting the tier at the
accept / keeper-match / refinance / obligation-transfer paths (self-imposed strict
mode), and the frontend wiring. Part of #671 (does not close it).

## Thread — Progressive risk access: acceptor-side gate + #662⇄#671 unification (PR #<n>)

Phase 2 of #671 (#728), PR-2a. The progressive-risk gate now also runs on the
party **accepting** an offer, not just the party that created it. When an offer
is accepted directly, the protocol checks the acceptor's vault tier against the
offer's pair (the riskier of the two legs governs) at loan initiation — so a
default-tier vault can't be steered into accepting an illiquid or mid-tier
position it never opted into. The creator was already gated when the offer was
posted (phase 1); this closes the other side.

Crucially, the acceptor does **not** have to sign a second consent. The
anti-phishing acceptance binding (#662) already makes the acceptor
cryptographically acknowledge every illiquid asset in the exact offer they're
taking, and the protocol verifies that acknowledgement at the same loan-init
point. That signed, per-acceptance acknowledgement is a stronger and more
specific consent than a standing per-pair record, so it now **satisfies** the
progressive-risk illiquid-consent requirement for the acceptor automatically.
The net effect: an acceptor who has opted their vault up to the right tier can
accept an illiquid pair with the single acceptance signature they already make —
no separate per-pair consent step. Only the vault tier still has to cover the
pair.

Four further hardening passes tighten the boundaries of that unification:

- **The offer creator is re-checked at accept, not just at create.** An offer
  posted while the gate was off, or whose creator has since dropped their tier,
  revoked an illiquid-pair consent, or fallen stale after a terms-version bump,
  is now rejected when someone tries to accept it — the create-time snapshot can
  no longer go stale and let an under-qualified position originate.
- **Only a genuinely-acknowledged asset can stand in for a per-pair consent.**
  The acceptance acknowledgement substitutes for the standing illiquid consent
  *only* for the exact assets the anti-phishing check actually validated. An
  asset that counts as illiquid for a subtler reason — a normally-liquid token
  whose on-chain depth has collapsed, or a rental's illiquid prepayment token —
  falls back to requiring an explicit standing consent, so a hand-crafted
  acknowledgement can't wave one through.
- **The buyer of a loan-sale is gated too.** When a lender sells their position,
  the exiting seller stays exempt, but the incoming buyer is now checked against
  the underlying loan's assets — a default-tier buyer can't acquire an
  illiquid-backed lender position without opting into that risk.
- **The frontend can pre-flight the gate.** A read-only preview tells the app,
  before a wallet ever signs, whether a given party would be blocked and
  why (tier too low vs. illiquid pair needs consent), so the accept button can
  guide the user instead of letting the transaction fail on-chain.

One related gap is deliberately left for a small follow-up: binding the
acceptance acknowledgement itself to the live risk-terms version (so a very
old, long-lived acceptance signature can't be replayed after a terms bump). It
needs a versioned field added to the anti-phishing acceptance structure, which
is tracked separately; the existing freshness guard on the vault tier already
narrows the window in the meantime.

As with the rest of #671, the whole check is behind the off-by-default
`riskAccessGateEnabled` master switch, and the lender-sale-vehicle *seller* stays
exempt. The keeper-driven matching path is deliberately not gated here — it
re-asserts each paired offer against its own creator at the matcher, which lands
in a following PR. Part of #671 / #728 (does not close them).

## Thread — Progressive risk access: keeper-match re-assertion (PR #<n>)

Phase 2 of #671 (#728), PR-2b. The progressive-risk gate now also runs on the
**keeper-driven matching** path. When a keeper pairs a standing lender offer with
a standing borrower offer, the protocol re-checks the resulting loan against the
live tier/consent state — at the matcher, before any funds move.

This closes the gap the acceptor-side gate (PR-2a) left open. That gate runs
only on the direct-accept path, where one party signs an acceptance; a keeper
match authors no such signature, so neither side was being re-validated at match
time. The check is evaluated against the **current** state rather than the
snapshot taken when the offers were posted: an offer can outlive the conditions
it was posted under — the gate may have been switched on after it was created, or
its creator may since have dropped their vault tier, revoked an illiquid-pair
consent, or gone stale after a risk-terms-version bump. Without a re-check at the
matcher, a keeper could settle a loan that the parties would not currently be
allowed to originate.

For an ordinary match, **both** offer creators are checked against the **borrower
offer's** pair — which is the pair the resulting loan actually carries, because
the match builds the loan from the borrower offer (its token ids and prepayment
token win over the lender offer's). Checking the actual loan pair, rather than
each offer's own declared pair, means the lender must satisfy the gate for the
position it really joins, not a looser pair it happened to advertise. When the
borrower offer is a protocol-mediated **loan-sale vehicle**, the split matches
the direct-accept semantics: the exiting seller is exempt (that risk was accepted
at the original loan) and only the incoming buyer is checked, against the assets
of the loan being sold.

To keep keeper bots from burning gas, a read-only **companion preview** reports
whether a candidate match would be blocked by this gate, and why (tier too low
versus illiquid pair needing consent), so a match the gate would revert is never
quoted as matchable.

The riskier of the two legs governs and NFT rentals are tiered off their
value-bearing prepayment token, identical to every other entry point. Each gated
party is checked as a standing participant — there is no acceptance signature on
this path, so nothing substitutes for a missing tier or consent. As with the rest
of #671, the whole check is behind the off-by-default `riskAccessGateEnabled`
master switch and is a no-op when it is off. Part of #671 / #728 (does not close
them).

## Thread — Progressive risk access: obligation-transfer gate (PR #<n>)

Phase 2 of #671 (#728), PR-2c. The progressive-risk gate now also runs on the
**obligation-transfer** path (Preclose Option 2). When a borrower hands their
loan obligation to a new borrower by consuming that new borrower's standing
Borrower Offer, the protocol now checks the **incoming** borrower against the
loan's asset pair before the transfer settles.

This closes another gap the acceptor-side gate (PR-2a) left open. The transfer
rewrites the loan's borrower directly — it does not route through the
offer-accept → loan-initiation chokepoint where that gate lives, so the incoming
borrower was never re-validated. The incoming borrower is newly taking on the
loan's borrower-side risk, so the right check is against the **loan's** asset
pair (the exposure being assumed), evaluated against the **current** tier and
consent state. Their Borrower Offer may have been authored while the gate was
off, or their tier or per-pair consent may since have dropped or gone stale
after a risk-terms-version bump; re-checking at transfer time catches all of
those. The **exiting** borrower stays exempt — that risk was already accepted at
the original loan, exactly as the seller of a loan-sale is exempt while its buyer
is gated.

The incoming borrower is gated as a standing participant: this is not an
acceptance flow, so there is no anti-phishing acknowledgement to substitute for a
missing tier or per-pair consent. As with the rest of #671, the whole check is
behind the off-by-default `riskAccessGateEnabled` master switch and is a no-op
when it is off. Part of #671 / #728 (does not close them).

## Thread — Progressive risk access: opt-in strict mode (PR #<n>)

Phase 2 of #671 (#728), PR-2d. Adds an **opt-in per-vault strict mode** to
progressive risk access. By default, a mid-tier (BroadLiquid) pair needs no
per-pair acknowledgement — the tier opt-up is itself the consent, and the
quantitative LTV / health-factor check still applies. A vault that wants a
stronger, deliberate gate can now turn **strict mode** on: while it is on, the
vault must hold a fresh **explicit** acknowledgement for **every** mid-tier pair
it originates, not just illiquid ones. This is what makes the strict-mode flag
actually enforce something.

The explicit acknowledgement is a separate, deliberate action
(`setMidTierPairAck`) — it is never auto-stamped by the protocol on first use, so
a strict-mode vault can't satisfy its own requirement by accident. The ack binds
to the exact assets (asset types + token ids) the signer reviewed and is anchored
to the current risk-terms version, so a governance terms bump re-locks it exactly
like the tier and illiquid-pair consents: the vault must re-acknowledge.

Turning strict mode **off** is treated as a risk-increasing change. It is
immediate by default, but on a deployment that has configured an opt-up cooldown,
the mid-tier acknowledgement requirement **lingers** for the cooldown window after
a disable — so a vault can't drop strict mode and originate an un-acknowledged
mid-tier loan in the same breath. Both the strict-mode toggle and the explicit
ack are available as direct self-calls and as relayer-submittable gasless signed
messages (the off-direction toggle carries the full signed envelope because it is
the risk-increasing direction).

To keep interfaces honest, the existing read-only risk preview now also reports
the strict-mode case — an interface can tell, before any signature, that a vault
in strict mode would be blocked on a mid-tier pair until it acknowledges, and
collect that acknowledgement first. A dedicated view also answers the question
directly for a given vault and pair.

The whole feature sits behind the off-by-default `riskAccessGateEnabled` master
switch, and strict mode itself is off for every vault until explicitly enabled —
so nothing changes for anyone who doesn't opt in. A deliberately-deferred
companion (a passive, analytics-only record of first mid-tier use, written by the
gate) is noted as a follow-up because it would require the gate to write state on
an otherwise read-only path. Part of #671 / #728 (does not close them).

## Thread — Progressive risk access: frontend wiring (PR #<n>)

Phase 2 of #671 (#728), PR-2e. The dapp now surfaces the self-sovereign
progressive-risk controls and warns a user before they sign an accept the
risk-access gate would reject.

A new **Risk Access** settings page lets a connected vault see and manage its
risk posture: its currently-effective tier (which reflects the on-chain
read-time re-lock — a raised tier still cooling down, or one made stale by a
risk-terms-version bump, shows as the safer effective tier until it settles) and
choose its tier (Blue-chip only / Broad liquid / Illiquid-custom). A held tier
that is not yet effective is shown as informational only; re-affirming it in
place is a deliberate follow-up (it needs a per-user terms-version read the dapp
doesn't have yet), so in the meantime a user lowers then re-raises the tier to
re-affirm. The page makes the product posture explicit: every vault starts at the
safest tier and opts up to riskier tiers only by its own choice — the same
blue-chip-default, opt-in-with-consent model the contracts enforce. It also shows
whether the gate is actually being enforced on the current deployment (the master
switch), and is shown only when the wallet is on a network with a deployed
contract. The entry sits in the main navigation (not behind Advanced mode) so a
retail user can always reach the opt-up controls.

The accept flow gains a **risk preflight**: when a user reviews an offer, the
dapp asks the read-only on-chain preview whether their wallet would be blocked by
the risk-access gate and, if so, shows why — tier too low, an illiquid pair that
needs a one-time per-pair consent, or (in strict mode) a mid-tier pair that needs
an explicit acknowledgement — instead of letting the transaction fail with an
opaque revert. The preview already accounts for the master switch, so the banner
is silent on deployments where the gate isn't enforced, and the on-chain gate at
loan initiation remains the real boundary; this is purely a UX guard.

Two pieces are a deliberate follow-up because they share the same missing
ingredient — the offer's prepayment-token field threaded through the offer cache,
needed to reconstruct the exact pair identity client-side: collecting the per-pair
consent / acknowledgement inline at accept time, and the **strict-mode** opt-in.
The strict-mode toggle is intentionally not exposed yet: enabling it requires a
way to record the per-pair mid-tier acknowledgement, so shipping the toggle
without that path would let a vault brick its own mid-tier accepts. Both land
together once the pair-acknowledgement path exists. Part of #671 / #728 (does not
close them).

## Thread — Version-stamp the acceptance acknowledgement against the risk-terms version (PR #<n>)

Follow-up to #728 (closes #730). Hardens the unification between the #662
anti-phishing accept binding and the #671 progressive-risk illiquid-pair
consent.

When an acceptor takes an offer whose asset pair is illiquid, the acceptance
signature they already sign can stand in for a separately-recorded standing
consent for that pair — so they don't have to sign twice. Previously the
"freshness" of that stand-in was judged only by whether the acceptor's vault
risk-tier had been re-affirmed since the last governance change to the risk
terms. That left a gap: someone who signed a long-lived acceptance for an
illiquid offer **before** a risk-terms change, and then re-affirmed only their
tier afterward, could still submit the old acknowledgement as if it were fresh.

The acceptance message now carries the live risk-terms anchor it was signed
against, and the gate requires that anchor to be current for the acknowledgement
to stand in for a consent. Crucially the anchor is an **unguessable secret**
published with each terms change and unavailable before the change is enacted —
neither the predictable version counter nor the (public) terms-document hash — so
a malicious interface cannot induce a user to pre-sign an acknowledgement for the
*next* terms version and have it activate on the next change. To keep the anchor
secret even when governance is a transparent on-chain timelock, a terms change is
published via a **commit–reveal**: the governance decision (slow/timelocked)
records only a hiding commitment (the queued calldata exposes nothing), and a
separate fast off-timelock operational authority reveals-and-activates the secret
atomically. Each anchor is single-use for the protocol's lifetime, so
re-publishing terms can never revive a stale acknowledgement; the human-readable
terms document and its hash are published separately for review.
A governance terms change therefore re-locks a pre-change acknowledgement exactly
as it re-locks a standing consent: the stale acceptance is rejected, and the user
simply re-signs against the new terms to proceed. Liquid offers and deployments
where the progressive-risk gate is off are unaffected. The dapp's accept flow
stamps the live anchor automatically, so there is no extra step for users.

As part of the same change, the redundant on-chain digest-preview view for the
acceptance message was removed (the digest is a pure client-side computation the
wallet already performs when signing), recovering contract-size headroom that
the new field would otherwise have consumed.

## Thread — Ack-aware accept preview: soft-warn instead of hard-block (PR #<n>)

Follow-up to #728 (part of #735, part of #671). The accept-time progressive-risk
preview now distinguishes an illiquid pair the accepting wallet's own acceptance
signature WILL clear from one it genuinely cannot — so the dapp can soft-warn and
let the user proceed instead of hard-blocking every illiquid accept.

Background: the #662⇄#671 unification lets the acceptor's signed illiquid
acknowledgement substitute for a standing per-pair consent at loan initiation, but
only when that acknowledgement names exactly the assets the gate classifies
illiquid (a rental's illiquid prepay token, or a liquid-looking asset demoted on
depth, are NOT covered) and the acceptor's risk terms are still fresh. The old
preview was standing-consent-only, so it surfaced the same "needs consent" block
for both cases, and the dapp conservatively disabled Confirm on all of them —
because it couldn't prove client-side which illiquid pairs the upcoming signature
would self-heal.

This change moves that proof on-chain. The accept preview now evaluates the
acceptor leg ack-aware: it models the acknowledgement the signing flow always
produces and reuses the exact per-leg classification the gate enforces, so it can
report a new SOFT outcome ("illiquid, but your acceptance signature acknowledges
it — proceed") separately from the remaining HARD block (a creator-side consent
gap, a rental-prepay / depth-collapsed leg the ack can't cover, or a stale tier
anchor). The dapp renders the soft case as a neutral, non-blocking note that
leaves Confirm enabled while telling the user they're taking on acknowledged
illiquid risk; the hard cases still disable Confirm exactly as before. The offer
CREATOR leg and the lender-sale-vehicle buyer stay conservative (neither carries
the acceptor's acknowledgement), so the soft path can never mask a real block.

No external contract signature changed — the existing `previewOfferAcceptBlock`
view was refined to emit the new soft code, so there is no ABI or diamond-cut
churn. The on-chain gate at loan initiation remains the real boundary; this is a
UX refinement on top of it. Remaining under the #735 umbrella: the strict-mode
dapp toggle + per-pair mid-tier acknowledgement recording (item 3).

## Thread — In-place risk-tier re-affirmation in the dapp (PR #<n>)

Follow-up to #728 (part of #735, part of #671). The Risk Access settings page can
now **re-affirm a held tier in place** when a governance risk-terms change has made
it stale, instead of forcing the user to lower then re-raise it.

A vault's opted-up tier becomes effective only while its anchor matches the live
risk-terms version; a terms change re-locks it. Previously the page could not
reliably tell a tier that was merely *cooling down* from a recent raise from one
made *stale by a terms change*, so it left both cases informational. A small new
read-only view exposes the vault's tier-anchor version, so the page now
distinguishes the two: a cooling tier stays informational (re-clicking would
restart the cooldown), while a stale tier shows a clear "the risk terms changed —
re-affirm to restore it" note and a one-click **Re-affirm current tier** button.
The button re-submits the same tier, which re-anchors it to the latest terms; on
deployments configured with an opt-up cooldown it becomes effective again once
that cooldown elapses (re-affirm re-arms the cooldown, exactly like any raise).
Older deployments without the new tier-anchor view can't tell stale from cooling,
so they simply don't surface the button.

## Thread — Strict-mode toggle + in-flow mid-tier acknowledgement in the dapp (PR #<n>)

Follow-up to #728 (part of #735, part of #671). The reference dapp now exposes the
two pieces of the progressive-risk strict-mode workflow that were deliberately
held back until the recording path existed: the **strict-mode toggle** on the Risk
Access settings page, and **in-place recording of a mid-tier per-pair
acknowledgement** in the accept flow.

A vault can now opt into (or out of) strict mode directly. Enabling it is
risk-decreasing and immediate; disabling it is risk-increasing, so the page warns
when a recent disable is still inside its cooldown window — during which the
mid-tier acknowledgement requirement stays in force, exactly as the contract
enforces, so a vault can't drop strict mode and originate an un-acknowledged
mid-tier loan in the same breath.

While strict mode is on, a mid-tier (liquid-but-not-blue-chip) pair needs a fresh,
deliberate per-pair acknowledgement that the ordinary signature does not cover —
and the contract enforces this at BOTH offer creation and accept. Both flows now
detect that block and offer a one-click "record acknowledgement" action that
rebuilds the exact risk-access pair — including the NFT-rental prepayment token,
now threaded through the offer cache so a rental's lend leg keys off the right
asset — and records it. The create form blocks submit until the acknowledgement is
effective; the accept review offers the recorder when the connected wallet is
itself the blocked party. Both read the contract's own
`midTierStrictBlocked(wallet, pair)` predicate, so an accept block that is actually
the offer CREATOR's missing acknowledgement (the preview reports the first failing
party) is shown as the creator's requirement rather than inviting the acceptor to
spend gas on an acknowledgement that won't clear it.

The acknowledgement is intentionally not atomic sign-and-use: on a deployment with
an opt-up cooldown it becomes effective only after that whole window (which a
deployment may configure up to 30 days), so the copy never promises a quick
unblock; the user re-opens the offer (or waits out the create gate) once it's
active.

The recovery flows record the acknowledgement / consent for the EXACT pair the
gate checks, resolved on-chain. This adds four read-only RiskAccess view selectors
(all wired into the deploy selector arrays + the exported ABI, so they must be cut
into the Diamond): `acceptMidTierAckPair` (a lender-sale vehicle gates the buyer
against the sold loan's pair, which the dapp can't reconstruct itself),
`previewCreatorBlock` (the authoritative creator-side verdict, folding in the
seller exemption + tier-before-ack ordering), and `isPairConsentPending` /
`isMidTierAckPending` (whether a recorded consent/ack is still cooling down —
computed on-chain against `block.timestamp` and gated on a current version + a set
flag, so the dapp suppresses a repeat write that would restamp a still-cooling
record but offers a fresh one once a terms bump or a revoke has invalidated it). Every setter/predicate the
rest of this uses already shipped with #728. The create form additionally checks
the creator's tier and illiquid-consent prerequisites before presenting the
acknowledgement as the fix (the gate checks tier first), and all the strict-mode /
ack reads degrade safely when the master gate is off or a read fails. This closes
the last open item under the #735 umbrella (the strict-mode toggle was the
deferred piece called out in the Risk Access page since #728 PR-2d).

## Thread — Relayed risk-access grants bind the unguessable terms anchor (PR #<n>)

Closes #737. Part of the #671 progressive-risk umbrella, and the sibling of #730:
where #730 re-anchored the acceptance acknowledgement to an unguessable, commit-
revealed risk-terms secret, this change closes the same root weakness on the
**relayed (gasless) self-sovereign grant** path.

A vault can authorise a risk-access change — a tier opt-up, an illiquid-pair
consent, a strict-mode toggle, or an explicit mid-tier acknowledgement — by signing
an EIP-712 message that a relayer later submits on its behalf. Previously each of
those signed grants was anchored to the **predictable numeric terms version**
(`current + 1`). Because that next version is guessable, a malicious interface could
induce a vault to pre-sign a grant for a terms version that does not exist yet, hold
it, and have a relayer submit it the instant governance enacted the next terms
change — silently re-establishing freshness against terms the user never actually
reviewed. On the illiquid-consent path that pre-signed grant could re-arm the
standing-consent branch of the accept gate and bypass the #730 acknowledgement
re-lock entirely.

Every relayed grant now binds the **unguessable `currentRiskTermsHash`** — the same
secret anchor the acceptance acknowledgement binds, published only at the atomic
commit-reveal activation of a terms change — instead of the version counter. A
relayed grant is honoured only if the anchor it names is the live one, so a grant
for a future terms epoch cannot be crafted at all (the future anchor is unknowable
until activation), and a grant signed against the previous epoch is refused after a
change just as before. A grant naming the zero anchor (the pre-first-reveal state,
where no real terms epoch exists yet and zero is trivially guessable) is also
refused: relayed grants carry no freshness meaning until a real anchor has been
revealed, which reinforces that the gate must not be enabled before that reveal.

The strict-mode toggle grant is included in the change even though it is not part of
the standing-consent bypass, because all four relayed grants share one signature-
consumption chokepoint; binding the anchor there closes the pre-sign vector for the
whole surface and avoids leaving one grant type still pre-signable.

This is security hardening with **no behaviour change for any live deployment**: the
progressive-risk gate is off by default and the platform is pre-live, so no relayer
path is in production. It is, however, a hard **pre-condition to enabling the gate**
on any network — especially a timelock-governed mainnet — and should land before
`riskAccessGateEnabled` is ever turned on. The four `*BySig` entry points keep their
names; their EIP-712 struct shape changes (a `bytes32 termsHash` field replaces the
`uint64 termsVersion`), so the relayer/ABI surface is re-exported alongside.
