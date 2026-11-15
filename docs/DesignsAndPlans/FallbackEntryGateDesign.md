# Fallback entry needs time, not one transaction (#3538)

## Problem

The HF liquidation and the time-based default are permissionless, and the
caller writes the swap try-list. #1005 refuses a list with no enabled route,
but one enabled route with deliberately broken data still counts as an
attempt. When it failed, the terminal forced sale returned `sold = false` and
the caller entered the in-kind fallback in the same transaction, so one
caller could deny the lender a sale at market and move the loan into custody.

## Alternatives considered

1. **Require one attempt per enabled adapter.** The caller still writes each
   adapter's data, so each attempt can be sabotaged the same way.
2. **A failed sale changes nothing but a record; the fallback opens only
   after failures spread over time** (chosen). One transaction can then only
   fail. The cost is a slower fallback when every venue is genuinely down: at
   least the minimum span after the first failure.
3. **A protocol-built route must fail too.** Needs an adapter that can quote
   and route from on-chain state alone, on every chain. None exists today;
   it can be added on top of 2 later.

## Recommendation (built)

Alternative 2, with the rule in one library and one writer.

- **Rule** (`LibFallbackGate`): a terminal forced sale whose routes all fail
  may enter the fallback only when the loan's record shows an earlier failed
  sale at least `MIN_SPAN` (10 minutes) old. A record whose latest failure
  is older than `STALE_AFTER` (1 day) reads as empty, so a loan that
  recovered and becomes liquidatable again starts a new record.
- **Where** (`ForcedSaleFacet.sellToNeed`, the one host every terminal sale
  runs through). Periodic and split sales never enter the fallback and take
  the direct path. A terminal sale with the fallback open also takes the
  direct path: on failure it gathers the collateral for the caller's
  fallback entry, as before. A terminal sale with the fallback not open runs
  in its own frame (`sellOrRefuse`, a self-call). That frame reverts
  `ForcedSaleRoutesFailed` when every route fails, which undoes the pull and
  the lien change. The host catches exactly that error, records the failure,
  emits `ForcedSaleFallbackDeferred` and returns `fallbackDeferred = true`.
  Any other revert propagates unchanged and records nothing.
- **Callers** (`RiskFacet.triggerLiquidation`, `DefaultedFacet.triggerDefault`)
  return without entering the fallback when the outcome is deferred. The
  trigger's earlier steps still apply: a swap-to-repay intent cancelled
  because the loan is liquidatable, an active prepay listing cleared, and the
  position consolidation. Each is a correct step for a loan that is due for
  a forced close, whether or not this caller's sale went through.
- **Read** (`ForcedSalePreviewFacet.getFallbackGate`): failures recorded,
  the first failure, and when the fallback opens.

## What it does not close

- A caller who sabotages two sales at least 10 minutes apart still opens the
  fallback, unless someone sells in between. The protocol's own keeper
  watches liquidatable loans each tick with a working route, so the window
  is the honest sellers' chance, not a guarantee.
- If every venue is genuinely down, the fallback opens 10 minutes later than
  before.
