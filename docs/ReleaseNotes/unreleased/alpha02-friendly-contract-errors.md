## Thread — plain-language contract errors + every error captured for support

When a transaction was rejected by the contracts, the app used to surface the
raw Solidity error name (e.g. `MaxLendingAboveCeiling`) in the pre-sign dry-run
footer, and — when the wallet's gas estimation swallowed the revert selector —
a misleading "oversized gas limit / missing approval / stale build" message on
the actual submit. A naive user hitting an under-collateralised borrow (asking
for far more than their collateral supports) saw both, with no readable
explanation of what actually went wrong.

Contract errors now translate to plain language everywhere they surface. The
shared error decoder maps the errors a normal user can actually reach —
borrow/lend/accept/repay bounds like "your collateral is too low for the amount
you want to borrow", consent and health-factor gates, self-trade, duration
caps, and so on — to friendly copy, and ANY other error falls back to a
humanized sentence built from its name instead of a hex blob. The mapping is
keyed by the stable error NAME rather than its 4-byte selector, so a
signature-level contract change can't silently break a message. The pre-sign
dry-run footer and the submit-error banner both read from this, so the review
step and the failure share one voice.

The misleading gas message is defused two ways: the offer flow now prefers the
dry run's concrete reason over the generic gas copy when the wallet estimation
strips the selector, and the generic copy itself was reworded to point at the
review-step reason first rather than only the approval/stale-build guesses.

Finally, a failed transaction is now recorded in the diagnostics sink that
feeds the support drawer and the pre-filled issue report — previously only a
render crash was captured, so a tx that reverted left no trace for support.
Every kind of error the user can hit now lands there.

No contract or ABI changes. The decode/humanize logic is unit-tested; the
end-to-end rendering is verified live against a real testnet revert per the
live-review definition of done. Closes the borrow-error UX follow-up.
