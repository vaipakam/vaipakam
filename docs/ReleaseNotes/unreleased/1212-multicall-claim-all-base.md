## One-transaction "Claim All" batching foundation (E-10, #1212)

Every payout on Vaipakam is pull-based — resolved-loan proceeds (lender and
borrower), interaction rewards, vaulted VPFI, un-lent lender-intent capital and
payroll each need their own claim transaction. A user with several eligible
payouts had to sign one transaction per claim.

This change adds the on-chain foundation for a one-click "Claim All": a generic
batching entry point that executes several Diamond calls in a single
transaction while preserving the caller's identity, so every batched action is
authorized exactly as if the user had called it directly — a keeper or a
stranger cannot claim on someone else's behalf through the batch.

The batch is **best-effort per item**: each item can be marked to tolerate
failure. For "Claim All" the interface marks every item that way, so if one
loan is not yet claimable — or was finalized by another party between the
preview and the transaction — that item is skipped and the rest still succeed,
rather than the whole batch reverting. An item can instead be marked
must-succeed, in which case its revert aborts the entire batch. The batch
reports, per item, whether it succeeded.

Safety: the batcher grants no capability a user does not already have on their
own — each batched call still runs its own reentrancy, pause, and
authorization checks against the real caller. It is non-payable (no value
re-use), rejects an empty batch, caps the number of items per call, and refuses
to nest inside itself. Note that the interaction-rewards claim remains bounded
to a fixed number of finalized days per call, so a single batch may not fully
drain a long-dormant user's rewards — the interface surfaces any residual.

This is the contract half of E-10. The Claim Center "Claim all eligible" UI —
the eligibility scan, per-item preview, and residual handling — is tracked
separately (#1268). Part of #1221; base for the opt-in keeper-swept-claims
follow-up.
