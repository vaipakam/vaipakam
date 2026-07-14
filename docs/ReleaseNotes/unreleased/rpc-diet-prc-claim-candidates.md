# RPC read-diet PR C — claim-candidate hint + memoized claim verdicts

Third phase-2 slice of the Alpha02 RPC read-diet design (§4.2.3),
targeting the connected app's single most expensive recurring read
surface: the Claims verification fan-out, which confirms every
candidate on chain (current position-NFT holder, claimable amount,
borrower rebate) at roughly three reads per candidate.

Two changes, neither of which moves the authority off chain:

The indexer gains a lean claim-candidate endpoint that lists the
terminal loans whose position NFTs a wallet currently holds, most
recently touched first, capped at the two hundred most recent with an
honest truncation marker. It is additive by contract: the connected
app consults it only as fallback discovery when the authoritative
on-chain enumeration is unavailable (an older deployment), and never
lets it suppress a candidate the chain found. The existing claimables
endpoint that another app consumes is untouched.

The connected app now remembers each candidate's verification verdict
for the session, keyed on the candidate's identity (loan, side,
status, position tokens, entitlement-relevant amounts). A re-check
whose candidates are unchanged spends zero chain reads; only
candidates whose identity actually changed are re-verified. Because
ownership can change without any of those fields moving — a position
NFT sold on a secondary market, a claim from another device — every
remembered verdict is discarded the moment an ownership-change push
signal or one of the user's own confirmed transactions arrives, and a
fresh page load always verifies from scratch. Transport failures are
never remembered as verdicts, so "couldn't confirm" still surfaces as
unavailable rather than a confident stale answer.
