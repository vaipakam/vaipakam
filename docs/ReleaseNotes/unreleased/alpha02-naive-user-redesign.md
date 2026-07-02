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

apps/defi is untouched and stays the live app until alpha02 reaches
parity; apps/alpha (the earlier static mock) is untouched and unused.
Follow-ups tracked in apps/alpha02/README.md: accept-offer path, NFT
rental flows, VPFI vault actions, on-chain fallback reads, HF display,
cancel-offer, sanctions/ToS parity, i18n extraction, and Playwright
journeys.
