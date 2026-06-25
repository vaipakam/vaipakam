## Thread — Ack-aware accept preview: soft-warn instead of hard-block (PR #<n>)

Follow-up to #728 (part of #735, part of #671). The accept-time progressive-risk
preview now distinguishes an illiquid pair the accepting wallet's own acceptance
signature WILL clear from one it genuinely cannot — so the dapp can soft-warn and
let the user proceed instead of hard-blocking every illiquid accept.

Background: the #662⇄#671 unification lets the acceptor's signed illiquid
acknowledgement substitute for a standing per-pair consent at loan initiation, but
only when that acknowledgement names exactly the assets the gate classifies
illiquid (a rental's illiquid prepay token, or a liquid-looking asset demoted on
depth, are NOT covered) and the acceptor's risk terms are still fresh. The old
preview was standing-consent-only, so it surfaced the same "needs consent" block
for both cases, and the dapp conservatively disabled Confirm on all of them —
because it couldn't prove client-side which illiquid pairs the upcoming signature
would self-heal.

This change moves that proof on-chain. The accept preview now evaluates the
acceptor leg ack-aware: it models the acknowledgement the signing flow always
produces and reuses the exact per-leg classification the gate enforces, so it can
report a new SOFT outcome ("illiquid, but your acceptance signature acknowledges
it — proceed") separately from the remaining HARD block (a creator-side consent
gap, a rental-prepay / depth-collapsed leg the ack can't cover, or a stale tier
anchor). The dapp renders the soft case as a neutral, non-blocking note that
leaves Confirm enabled while telling the user they're taking on acknowledged
illiquid risk; the hard cases still disable Confirm exactly as before. The offer
CREATOR leg and the lender-sale-vehicle buyer stay conservative (neither carries
the acceptor's acknowledgement), so the soft path can never mask a real block.

No external contract signature changed — the existing `previewOfferAcceptBlock`
view was refined to emit the new soft code, so there is no ABI or diamond-cut
churn. The on-chain gate at loan initiation remains the real boundary; this is a
UX refinement on top of it. Remaining under the #735 umbrella: the strict-mode
dapp toggle + per-pair mid-tier acknowledgement recording (item 3).
