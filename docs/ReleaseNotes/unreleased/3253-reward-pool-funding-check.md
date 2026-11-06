## Keeper — a fresh Base can no longer launch rewards unfunded (PR #3263)

On the canonical chain the daily reward budgets sent to the mirrors draw only on what an admin has delivered into the reward pool. The 69M interaction pool is an allocation, not a balance, so a fresh Base starts with nothing to send. After the 2026-11-03 fresh deploy nobody funded it, and day 1 never reached Arbitrum Sepolia or BNB Testnet until an operator spotted it by hand.

Two places now refuse that state. The script that sets the one-shot rewards launch anchor refuses on the canonical chain while the reward pool has no delivered headroom, and names the funding step. The deploy scripts' verify phase (testnet and mainnet) gains a reward-funding step: it prints what was received, paid and what remains. It fails a canonical chain whose rewards are launched with nothing left to send, and it states "not funded yet" before launch. A read that does not answer fails the step; it is never taken as funded. Mirrors are funded by Base's sends and are not checked.

The check asks only that some headroom exists. How much to fund is the operator's decision, so the figures are printed for them to read. The deployment runbook now orders the funding before Base's anchor, and the two-chain test harness funds Base before it sets the anchor, as a real deploy must.

The lens documentation for the delivered-fresh bound also said the bound does not apply on the canonical chain. That has been untrue since the canonical bound was introduced, and is now corrected.

Closes #3253 (the keeper alert half shipped in #3254).
