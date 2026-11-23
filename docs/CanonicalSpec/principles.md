# Principles

A principle is not a statement. It says what the platform is for, names the statements that
enforce it, and names the check that watches them. Where a principle and a statement differ,
the statement governs and the difference is a defect of this page. A principle changes only
by the owner's decision.

| Id | Principle | Enforced by | Watched by |
| --- | --- | --- | --- |
| P1 | **No asset is gated.** The platform keeps no list of permitted assets. Guard rails take the place of a list | PLT-123, PLT-124, PLT-080. An asset that is not liquid is worth nothing to a risk figure and is used only where both parties named it: PRC-530, PRC-531. The guard rails: the tiers (PRC-520, PRC-522, PRC-523), the exposure limit (PRC-540), concentration (PRC-630 to PRC-633) and the floor of a forced sale (PRC-650) | The feature ledger: no step admits or refuses an asset by a list |
| P2 | **An asset is paused only on stated grounds.** One asset may be closed to new positions for hostile token code, a broken or manipulated price, or a token posing as another. Each use is published with its ground. Every close-out stays open | PLT-050, PLT-051. (AUT owed: the grounds of an asset pause, who places and who lifts it, and how each use is published.) | Every asset pause on a network carries a ground from the list |
| P3 | **No user's funds ever rest with another user's.** Funds move from vault to vault. Nothing is pooled and no interest is shared | PLT-010, PLT-011, PLT-012, PLT-013, VLT-001, VLT-002 | The never statements of the vault domain, watched on every vault |
| P4 | **What is owed to a position is paid to its holder's vault.** Only the owner's own withdrawal reaches a wallet | PLT-001, PLT-002, PLT-003, PLT-004 | The check on raw payouts, and VLT-037's watch |
| P5 | **One unit of account (the numeraire) and one predominant denominator of the price sources at a time, and each can be changed on a live deployment.** The unit is the measure every threshold and value is stated in. The denominator is the unit the price sources are predominantly quoted in. Neither is a token, and no token is assumed to hold a value: each is priced from its own source. Each changes only by governance's one guarded replacement of the price guard, after its wait. A change of denominator keeps the unit. A change of unit converts every figure kept in the unit alike. Neither touches a loan, lien, claim or balance | PLT-080. The unit: PRC-400, PRC-401, PRC-402, PRC-404, PRC-405, PRC-406, PRC-410, PRC-411, PRC-412. The denominator: PRC-100, PRC-104, PRC-414. The one replacement step: PRC-300, PRC-303. The map of every figure in the unit: PRC-440, PRC-441 | The launch check: the unit the platform records is the price guard's. The unit map and its check (PRC-441): no figure in the unit bypasses the one rule |
| P6 | **The lender's side is made whole first.** | PLT-122 | The worked examples of each close-out |
| P7 | **Facts, and the party decides.** The platform states what it can substantiate and what it does not know, and guides no one | PLT-020, PLT-121 | The first-time-user review (register row B9) |
| P8 | **Every movement of funds is on the public record,** with what moved and why | PLT-120, VLT-003 | The catalogue's balance check on every path |
| P9 | **A way out is never closed.** A repayment, a collection, an owner's withdrawal and a close-out stay possible under every condition the statements name | PLT-041, PLT-051, PLT-061, VLT-005, VLT-050, VLT-092 | The always-possible statements at scale (register row B3) |
| P10 | **Security is never traded for a feature.** A feature ships only if the platform is as safe with it | The launch register: no row is closed by a card alone | The launch check |

## What P3 does not say

P3 is true as written only with its exceptions stated:

- Inside one transaction funds pass outside a vault: a collateral sale (VLT-040), and a loan
  taken and returned in one step (VLT-043).
- The platform's own money rests in the treasury's vault and the backstop's vault (VLT-212).
  Those are not users' funds.

## What P5 needs of a new denominator

A price guard whose sources are quoted in another denominator states the peg of a stable asset
in that denominator (PRC-104), and the sizes of the liquidity test stay stated in the unit of
account and are converted when the test runs (PRC-414).

## Record

The owner adopted the principles in outline on 2026-11-22. He changed P5 at 17:10 UTC that
day, to name the numeraire together with the predominant denominator of the price sources and
to say that both can be changed on a live deployment, and approved it as written here at
17:15 UTC.
