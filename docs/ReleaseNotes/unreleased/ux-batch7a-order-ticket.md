### Rate Desk order ticket — clearer why-disabled, re-confirm note, Max chips + fee preview (UX-009 / UX-016 / UX-027)

The Rate Desk order ticket used to grey out its **Post order** button with
no explanation, silently un-tick the risk-terms checkbox on every
keystroke, and never show the protocol fees it had already loaded. Three
fixes:

- **Why it's disabled.** The ticket now shows the first unmet reason
  directly under the button — connect your wallet, switch to a supported
  network, pick a market, enter the amount / rate / collateral, accept the
  terms, or (for gasless posting) the order-book service being down. When
  no wallet is connected it renders a **Connect** button instead of a
  dead-disabled Post.

- **"Terms changed — please re-confirm."** Editing any term clears the
  consent checkbox (the deal being consented to changed underneath it); the
  ticket now says so beside the box instead of letting the un-tick read as a
  bug. The note only appears when a consent you had actually given was
  cleared, and disappears the moment you re-confirm.

- **Max chips + a fees & commitment summary.** A **Max** chip fills the leg
  you actually escrow from your wallet balance (a lender's amount from the
  loan-asset balance, a borrower's collateral from the collateral balance),
  and a short summary before consent states what you commit now (or "at
  fill" for a gasless order) plus the protocol fee that applies to your side
  — a lender's net yield after the fee on interest, a borrower's one-time
  loan-initiation fee on the principal.
