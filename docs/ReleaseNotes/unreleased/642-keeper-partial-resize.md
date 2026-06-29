## Keeper resizes partial liquidations in-tick instead of giving up (#642)

When the reference keeper liquidates only part of an unhealthy loan, the
contract can reject the requested slice for two recoverable reasons: the slice
is a little too large (it would over-correct the loan's health), or it exceeds a
governance-set cap on how much of a loan one liquidation may close. Previously
the keeper reacted to these by either skipping the loan until the next cycle or
jumping straight to a full liquidation.

The keeper now handles both **within the same cycle**:

- If the slice is too large, it shrinks the slice, re-prices the swap for the
  smaller amount, and retries — a few bounded attempts — so a healthy partial
  still goes through instead of waiting for the next cycle.
- If the slice exceeds the close-factor cap, it reads the live cap from the
  contract, clamps the slice to it, re-prices, and retries — only falling back
  to a full liquidation if the cap leaves no usable partial.

To support this, the contract exposes the live close-factor cap through a new
read-only view so the keeper can clamp precisely rather than guess. This is a
keeper-ergonomics improvement only: the on-chain guards remain the safety
boundary (a mis-sized slice simply reverts before any funds move), so there is no
change to liquidation outcomes or user funds — only fewer wasted cycles and fewer
unnecessary escalations to full liquidation.
