## Pre-grace warning banner on the loan detail page (#545)

Borrowers who rely on auto-refinance to roll their loan now see an inline warning
on the loan detail page when the loan is close to defaulting — even if they never
subscribed to Telegram or push notifications.

When the connected wallet is the loan's borrower, the loan has auto-refinance caps
enabled, and the loan is within the final 24 hours before it enters its grace
period, a prominent banner appears near the loan title. It explains that
auto-refinance is best-effort — if no compatible lender offer is matched before
grace expires, the loan will default — states how many hours remain until grace
begins, and makes clear repayment is accepted until the grace period itself
expires (not merely until maturity). It offers two shortcuts: jump to the
refinance-caps editor (to widen the caps if the market has moved) or open the
repay flow directly. The banner reflects a caps enable/disable immediately, and
the repay shortcut only appears when the repay action is actually available to
the connected wallet.

This mirrors the existing keeper-side pre-grace notification so the warning reaches
anyone who opens the page, not only notification subscribers. It is advisory and
changes no on-chain behaviour or repayment obligation.

It also replaces the earlier, less prominent in-card pre-grace note (which had no
call-to-action and sat lower on the page) so the borrower sees a single, clear,
actionable warning rather than two duplicates.
