# Weird-ERC20 hardening sweep + surface curation (ethos hardening)

**Status:** sweep methodology + design. Card: #1220. Umbrella: #1221.
Companion: `LiquiditySpoofingThreatModel.md` (probe defence — load-bearing,
scheduled ahead of new listing-surface features per the owner-accepted
ethos assessment,
[`UserValueEnhancementOpportunities.md`](UserValueEnhancementOpportunities.md) §6).

## Why

The platform ethos — lend any token against any token, made safe by
bilateral isolation — is only as strong as the settlement paths' behaviour
under non-standard tokens. The long tail is where non-standard lives.
This is the one-time engineering bill for "ungated at the protocol".

## The token-behaviour matrix

Every row below × every settlement path (initiation, partial/full repay,
swap-to-repay, liquidation incl. fallback + internal match, preclose 1–3,
early-withdrawal 1–2, claims, rental prepay/buffer, vault
deposit/withdraw, stuck-token recovery):

| Behaviour | Required protocol answer |
| --- | --- |
| Fee-on-transfer | Received-balance delta measured at vault deposit is truth for principal/collateral/repay accounting; any path assuming `amount transferred == amount received` is a finding |
| Rebasing (up) | Protocol-tracked balance is authoritative (`min(actual, tracked)` clamp, generalized from the VPFI rule); positive drift accrues to the vault owner via the untracked-surplus path, never silently to counterparties |
| Rebasing (down) | Tracked > actual must fail visibly at settlement (insufficient balance), never mis-pay a third party's funds; document as an accepted listing risk in the trust-tier copy |
| Blacklistable (USDT/USDC-style) | Every terminal path must tolerate a reverting transfer to a frozen party: pull-claim containment — the OTHER party's settlement and the loan's terminal state must complete regardless (mirrors the sanctions Tier-2 close-out principle) |
| Pausable / honeypot | Advisory pre-listing probe (below); terminal paths must strand only the affected leg, recoverable when unpaused |
| Reentrant hooks (777-style) | ReentrancyGuard coverage audit per facet entry point incl. internal-call compositions (the #951 collision class) |
| Non-standard returns (no-bool / false-return) | SafeERC20 everywhere — sweep for raw `transfer`/`transferFrom` |
| Weird decimals (0, 2, 24+) | Display + oracle-scaling correctness; no hardcoded 1e18 assumptions outside documented invariants |
| Double-entry / proxy pairs (two addresses, one balance) | Encumbrance accounting keyed per-address must not double-count; note as monitored risk |

## Sweep methodology

1. **Mock arsenal:** add malicious/weird ERC-20 mocks (FoT, rebase up/down,
   blacklist, pausable, reentrant, false-return, 0/24-decimals) under
   `contracts/test/mocks/` — reusable forever.
2. **Matrix test suite:** parameterized scenario tests driving each
   settlement path with each mock; every cell = pass / documented-finding.
3. **Findings triage:** actual bugs → individual `bug`+`security` issues
   fixed on their own PRs (this card tracks the sweep, not the fixes);
   accepted behaviours → recorded in `_CodeVsDocsAudit.md` + trust-tier
   copy.
4. **Regression lock:** matrix suite joins the standing test set so a new
   settlement path must declare its matrix behaviour.

## Advisory transferability probe (offer-time, off trust path)

At offer creation with an unknown token, the frontend simulates
vault-out transferability (`eth_call` of a self-transfer from the vault)
and shows the result as a badge — catches most honeypots before a lender
funds one. Advisory only: failure warns, never blocks (ungated protocol);
probe outage changes nothing.

## Trust-tier display layer

UI badges, zero protocol gating: `verified` (curated metadata list) /
`probe-passed` (liquidity probe + transferability) / `unknown`. Rides the
existing progressive risk-access tiers (user-chosen universe). Copy for
each tier states the residual risks in plain language (incl. rebase-down
and blacklist notes above).

## Acceptance

Matrix suite green or triaged; mock arsenal merged; badges live behind the
existing tier UI; probe e2e; `LiquiditySpoofingThreatModel.md` follow-ups
scheduled ahead of any new listing-surface feature on the board.
