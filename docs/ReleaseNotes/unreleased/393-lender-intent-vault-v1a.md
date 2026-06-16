## Thread — LenderIntentVault v1-a: standing lending intents (PR pending)

The first slice of the LenderIntentVault (the "set-and-forget supply" layer of the
hybrid intent program). A lender can now register a **standing lending intent** for
an ERC-20 asset-pair — a set of bounds describing the loans they're willing to make:
the most principal they'll have out at once, a minimum interest rate, a maximum
loan-to-value, a maximum term, and a smallest acceptable fill size. The intent is a
one-time on-chain setting; the lender's funds stay in their existing vault and never
move when the intent is registered.

This release ships only the standing-terms surface — registering, updating, reading,
and cancelling an intent, plus a governance kill-switch for the feature. The fill path
that turns a standing intent into actual loans arrives in the next slice. Crucially,
the design keeps the **depositing lender as the lender-of-record** on any loan their
intent later produces: the intent is a layer on top of the existing vault, not a new
contract that holds funds, so every downstream behaviour a lender relies on today
(claiming repayments, fee discounts, the position NFT being transferable) is the exact
same audited path — unchanged.

Registering an intent is screened against the sanctions oracle like any other new
lending commitment; cancelling one is always allowed (a flagged lender can always wind
down their standing exposure). The bounds are validated on entry — a zero asset, zero
exposure, a minimum fill larger than the exposure cap, a missing or above-100% LTV
ceiling, or a zero term are all rejected — so a registered intent is always
well-formed. Intents are independent per asset-pair. The feature ships **off**: lenders
can register intents, but no fill executes until governance enables the path after the
testnet bake (the same ship-off / governance-on / break-glass-off pattern the matching
and partial-fill features use).

Part of #393 / the hybrid intent program (does not close the umbrella). Next slices:
the permissioned-solver fill path, the solver-authorization gate, and auto-roll.
