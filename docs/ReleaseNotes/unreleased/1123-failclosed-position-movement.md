## Confirmed-flagged wallets can't move a position during an oracle outage (PR #<n>)

The platform screens sanctioned wallets against an on-chain oracle. That screen
is deliberately *fail-open*: when the oracle is unreachable it lets activity
through, so a vendor outage never freezes the whole platform. But for the narrow
act of **moving a loan-position token** (a plain transfer, or selling/transferring
a position through the sale and obligation-transfer flows), fail-open left a hole:
a wallet that had been confirmed sanctioned could move its position during an
oracle outage, which is the manoeuvre a determined actor would use to shuffle a
frozen position through intermediaries and eventually cash it out from a clean
wallet.

This change adds a small on-chain registry of wallets that were **confirmed
flagged while the oracle was reachable**, and has the position-movement checks
consult it **fail-closed**: a registered wallet cannot move a position even while
the oracle is down. The registry is filled automatically whenever the protocol
observes a flagged holder on a normal (non-reverting) path — when a flagged
wallet is caught trying to sell a position (the buyer is registered), and when a
disowned vault's stuck-token recovery reveals a flagged source — and can also be
synced by anyone through a new permissionless `refreshSanctionsFlag` call, which
both registers a freshly-listed wallet and **clears** a wallet the oracle now
reports clean (a de-listing lifts the restriction). All registry updates come
only from an authoritative, reachable-oracle read, so an outage can never wrongly
clear a still-flagged wallet, and an authoritative-clean move self-heals a stale
entry. (Registering the flagged *holder* of a closing position is owned by the
sanctioned-proceeds fail-closed release, #1006, which records the same holder at
close-out; the operator refresh is the backstop until that lands.)

Behaviour is unchanged for everyone else: when no oracle is configured the
registry is ignored entirely, and a wallet never previously observed as flagged
is not blocked during an outage. A flagged buyer is treated by *how* they are
acquiring the position: on the **direct buy-offer sale** — a value-receiving
acquisition — the transaction now reverts cleanly, blocking a flagged wallet from
buying in; on the **accepted-sale completion** path a sale still **completes** with
the flagged buyer's proceeds frozen (the existing "frozen, not seized" treatment),
and the flagged buyer is registered. On both paths a flagged *seller* offloading a
position is blocked. A de-listed wallet regains full movement.

This is the foundation that lets the sanctioned-proceeds fail-closed release
(#1006) rely on a single recorded frozen claimant per loan side: because a flagged
holder can no longer hand the position off mid-outage, no chain of distinct
flagged holders can form.

The full user-initiated movement surface is covered — plain transfers, the two
lender-sale vehicles, and the borrower-side obligation transfer. (A separate,
pre-existing size-limit item on the preclose facet — the direct-preclose lender
payoff to a flagged stored lender — remains tracked in #1124; it is unrelated to
position movement.)

Closes #1123.
