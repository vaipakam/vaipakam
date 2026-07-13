# Borrower auto-protect — HF-band keeper action (E-4)

**Status:** design for review before build (contracts + keeper + UI).
Card: #1206. Umbrella: #1221. Related: `KeeperAuthorityMatrix.md`,
swap-to-repay (§6), add-collateral (Phase 1 additions).

## Problem

Liquidation avoidance is manual: advisory warnings, best-effort
auto-refinance, and a spec that tells borrowers to monitor. The worst user
outcome on the platform (liquidation with its stacked charges) is
preventable with pieces that already exist.

## Design

Per-loan, opt-in, borrower-configured automation:

```
AutoProtectConfig {
  hfTriggerBand;      // e.g. act when HF < 1.25 (bounded: [1.05, 1.45])
  hfTarget;           // restore to, e.g. 1.35 (must be > band + margin)
  action;             // TOP_UP_COLLATERAL | PARTIAL_SWAP_REPAY
  sourceCap;          // max cumulative amount spendable (per loan), denominated in the bound source asset
  perActionCap;       // max per execution, same denomination
  maxSlippageBps;     // PARTIAL_SWAP_REPAY only; bounded by the protocol swap-to-repay knob
  cooldown;           // min seconds between executions (anti-thrash)
  enabled;
}
```

Execution — a new narrow keeper grant `KEEPER_ACTION_AUTO_PROTECT`
(per-action opt-in, consistent with the ≤5-address whitelist model):

- **TOP_UP_COLLATERAL:** move collateral asset from the borrower's *free*
  (un-liened, un-locked) vault balance into the loan's collateral via the
  existing add-collateral path. Same-asset only (existing rule).
- **PARTIAL_SWAP_REPAY:** bounded partial repayment via the existing
  swap-to-repay adapter failover, subject to the config's
  `maxSlippageBps` (itself bounded by the dedicated protocol knob) and
  the strictly-positive-remaining-principal rule.

**The source asset is BOUND by the config + loan structure, never
keeper-chosen** (Codex round-2): TOP_UP spends only the loan's collateral
asset from free vault balance; PARTIAL_SWAP_REPAY swaps only the loan's
own collateral through the governed swap-to-repay route. The keeper picks
no asset, no route, and no price — every degree of freedom is fixed by
the borrower's signed config or the protocol's governed adapter list.

**Two distinct source models** (Codex round-3 — do not conflate):

- **TOP_UP_COLLATERAL consumes FREE balance** — un-liened, un-locked
  vault balance moves *into* the loan's lien. `sourceCap` /
  `perActionCap` denominate free balance spent.
- **PARTIAL_SWAP_REPAY consumes PLEDGED collateral** — that is what
  swap-to-repay structurally does: it sells part of the loan's liened
  collateral to reduce the debt. It never touches free balance or any
  other asset. For this mode `sourceCap` / `perActionCap` denominate
  pledged collateral sold, and the HF-restoration math accounts both
  sides of the move (collateral down, debt down). The consent copy for
  this mode must state plainly that it spends pledged collateral.

The free-balance-only encumbrance guard below applies to TOP_UP; the
swap mode's guard is instead "the loan's own pledged collateral only,
within the signed caps".

**Position-transfer semantics (Codex round-5 P1):** the config is bound
to the position holder who signed it, not to the loan. `AutoProtectConfig`
stores the signer, and execution requires
`ownerOf(borrowerPositionNFT) == config.signer` — a borrower-position
transfer therefore **silently disables** the config (skip + event
`AutoProtectSkipped(loanId, HOLDER_CHANGED)`); the new holder must sign
their own config and keeper grant before any auto-protect action can run
against their collateral or balances. This is the same staleness rule
two-sided auto-extend applies to its caps on NFT transfer. Without it,
the previous holder's signed caps could spend the new holder's pledged
collateral (swap mode) or free balance (top-up mode).

Guards:

- Only liquid-collateral loans (HF exists only there; illiquid loans have
  no trigger — UI must say so).
- Amount computed on-chain at execution: minimum needed to reach
  `hfTarget`, clamped by `perActionCap` and remaining `sourceCap` —
  the keeper supplies no discretionary numbers.
- Encumbrance discipline (TOP_UP mode): draws ONLY from free balance
  after liens, offer locks, intent working-capital locks, and claim
  reservations (`EncumbranceLifecycleMap.md` is the consult surface).
  PARTIAL_SWAP_REPAY instead operates strictly within the loan's own
  lien per the two-source-model rule above. Neither mode creates a new
  lien class; both move value between existing structures.
- Mutual exclusion: skips (no revert) while a preclose offset, sale
  listing, or refinance is live on the loan — those flows freeze position
  mutations.
- Failure = skip + event, never revert-the-sweep: insufficient free
  balance, cooldown, oracle unavailable, slippage exceeded → emit
  `AutoProtectSkipped(loanId, reason)` and continue.

Events: `AutoProtectConfigured/Disabled`, `AutoProtectExecuted(loanId,
action, amountIn, hfBefore, hfAfter)`, `AutoProtectSkipped`.

## Keeper + UI

- Keeper pass: scan configured loans below band (reuse HF-watcher band
  machinery), execute bounded batch; permissionless-safe because all
  economics are on-chain-computed and configs are borrower-signed.
- UI: configure from Loan Details; Dashboard badge "protected"; history of
  executions; explicit copy that this is best-effort convenience, not a
  guarantee (consistent with auto-refinance framing).

## Why not auto-pull from wallet

Wallet-pull requires standing allowances vulnerable to drainer UX and
weakens the vault encumbrance model; free-vault-balance-only is the
conservative v1. Wallet-sourced top-up can be a later opt-in following the
refinance wallet-pull precedent.

## Tests

Band trigger math incl. clamps; encumbrance non-violation (attempt to
draw liened balance fails); cooldown; mutual-exclusion skips; swap
slippage fallback; keeper-grant enforcement; config bounds; events.
Scenario: price drop → top-up → HF restored → no liquidation; sourceCap
exhausted → liquidation proceeds normally (auto-protect must not block
liquidation paths).

## Spec edit

ProjectDetailsREADME: new subsection under borrower collateral management;
FunctionalSpecs domain doc updated in the implementing PR.
