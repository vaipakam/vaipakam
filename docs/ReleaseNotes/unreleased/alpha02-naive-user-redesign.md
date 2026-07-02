## Thread — alpha02: naive-user-first connected-app redesign (PR #TBD)

A new frontend surface, `apps/alpha02` (`@vaipakam/alpha02`, to serve at
alpha02.vaipakam.com), begins the ground-up redesign of the connected app
for non-expert users. It implements the intent-first, progressively
disclosed product direction from the Basic User UX Simplification Plan:
the first screen asks what the user wants to do (borrow, lend, rent an
NFT, manage positions); every write flow shares one six-row review
receipt (you receive / you lock / you may owe / you can lose / fees /
when this ends) and a fixable-items eligibility checklist; empty states
distinguish "truly empty" from "couldn't load"; unknown routes land on a
recovery page instead of a blank screen. The app is mobile-first (bottom
tab bar under 720px), ships light and dark themes, and carries a
persisted Basic/Advanced mode switch that reveals advanced controls in
place without navigating.

Wired end-to-end in this first cut: wallet connect (wagmi + ConnectKit,
mirroring apps/defi's connector decisions), deployment-driven chain
support with plain-language network gating, guided borrow/lend flows
that post offers through the Diamond (allowance handled inline, payload
mapping copied verbatim from apps/defi's offerSchema), positions list
and loan detail with repay and claim actions, Claim Center, Offer Book
browsing, and an availability-first VPFI education page. It also designs
out the five findings of the 2026-07-02 naive-user browser audit
(curated asset picker, honest offer-book empty states, availability-first
VPFI state, user-centred network copy, no blank route dead-ends).

The accept-offer journeys (B1: borrower uses an existing lender offer;
L1: lender funds an existing borrow request) are wired as the guided
flows' primary path: after the user states asset, amount, and duration,
the flow surfaces matching open offers first — accepting one opens the
loan immediately — and posting their own offer is the explicit
fallback. Accepting signs the EIP-712 AcceptTerms against the canonical
on-chain offer (ported from apps/defi's useAcceptTermsSigning, with the
fail-closed risk-terms-hash behaviour preserved), approves the
acceptor-side asset for the exact signed amount, and calls acceptOffer.
The Offer Book gains a "Use this offer" action that deep-links into the
same review-and-sign step.

The VPFI vault journey (V1) is live: the page decides availability
first (a chain without a registered VPFI token — or a failed check —
never shows deposit controls), shows the tracked vault balance and the
ACTIVE effective discount with a plain "warming up" note when the raw
balance-implied tier is higher (the fee path applies a 30-day average
behind a minimum-history gate), carries the platform-level consent
toggle, and runs deposit/withdraw through the shared review receipt
with exact-amount approvals.

The NFT rental journeys (N1/N2) are live and deliberately separated
from debt lending: an owner lists an NFT (ownership verified in the
checklist before any gas, collection approval granted only when
missing, rentals created at a 0% rate since fees are prepaid), and a
renter browses listings and rents with the full prepay — daily fee ×
days plus the live refundable buffer — spelled out before signing,
computed from the signed canonical terms at approval time. Positions
and detail pages now speak "rental" for NFT legs (close/claim, never
"repay"). One deliberate divergence from apps/defi: the daily fee a
user types is scaled by the payment asset's decimals before it goes
on-chain; apps/defi's form sends the typed number through unscaled,
which is flagged in the page header as a candidate code-vs-docs audit
entry.

The completion pass fills out the remaining product surfaces: open
offers are cancellable from My positions (two-tap confirm, releases
the locked side); loan details gain a plain-language health row
(health factor + loan-to-value from RiskFacet — label only in Basic,
numbers in Advanced, and an explicit "no automatic liquidation" note
for unpriced/illiquid legs), an add-collateral action, and partial
repayment for opt-in loans in Advanced mode; a "Your Vaipakam Vault"
page shows per-asset total/locked/free with totals clamped to the
protocol-tracked balance; the Claim Center gains the
interaction-rewards claim with an honest "being finalized" waiting
state; a sanctions banner (fail-open, shown only to oracle-flagged
wallets, with wind-down paths explicitly kept open) renders across
the app; an Activity page joins the Advanced navigation; and NFT
rental listings in the Offer Book deep-link into the guided renter
flow.

A max-effort review pass (ten finder angles, adversarial verification,
gap sweep) plus the Codex PR review then hardened the whole surface.
Consent-integrity: accepts now re-verify the signed canonical terms
against the reviewed offer (and its chain) and abort with a plain
notice on any mismatch; unpriced (illiquid) legs get an explicit
in-kind-transfer warning before signing; the sanctions check joined
the pre-approval checklist so a flagged wallet never pays approval gas
for a doomed transaction. Funds-access: loan actions follow the
current position-NFT holder (transferees were locked out as
"viewers"); borrowers can claim residual entitlements after
default/liquidation (the Claim Center listed rows the detail page
couldn't act on); VPFI withdrawals cap at the FREE (unencumbered)
balance and the Max button is lossless. Honesty: partial indexer
failures now read as "unavailable" instead of confident half-lists;
the rental prepay buffer and all fee/tier copy are read live from
protocol config (never a hardcoded default at signing time); RPC
failures no longer masquerade as "no liquidation applies"; overdue
loans no longer show "Due today". Robustness: wallet-rejection
detection uses error types instead of a message regex that matched
the word "cancel" inside cancelOffer reverts, with contract errors
decoded via the shared @vaipakam/lib decoder (fixing the #780
gas-limit trap); non-numeric amount/rate inputs can no longer crash
the page; approvals zero-first for USDT-style tokens; repay approvals
carry day-boundary headroom; deep links validate asset kind, side,
ownership, and existence; RPC transports batch; the Safe-App connector
is included. The defi rental daily-fee unit divergence was filed in
docs/FunctionalSpecs/_CodeVsDocsAudit.md and the alpha02 intended
behaviour was added to docs/FunctionalSpecs/WebsiteReadme.md.

apps/defi is untouched and stays the live app until alpha02 reaches
parity; apps/alpha (the earlier static mock) is untouched and unused.
Follow-ups tracked in apps/alpha02/README.md: accept-offer path, NFT
rental flows, VPFI vault actions, on-chain fallback reads, HF display,
cancel-offer, sanctions/ToS parity, i18n extraction, and Playwright
journeys.
