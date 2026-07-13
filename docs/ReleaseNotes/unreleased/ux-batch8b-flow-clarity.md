### Guided flow + offer-card clarity — earlier wallet prompt, role-specific CTAs, role-checking state, consistent empty state, "Post another" (UX-014 / UX-018 / UX-025 / UX-040 / UX-041)

- **Connect prompt up front (UX-014).** The guided borrow/lend flow now
  shows a non-blocking "connect your wallet" note with a Connect button on
  its first step, so a disconnected user isn't told only at the final review
  that they need a wallet to sign. Browsing matches while disconnected still
  works.

- **Role-specific offer CTAs (UX-018).** An offer-book card's action now
  says what taking it does: **"Borrow this"** on a lender offer (you become
  the borrower) and **"Fund this request"** on a borrow request (you become
  the lender), instead of a direction-blind "Use this offer".

- **Role-checking placeholder (UX-025).** On a loan's detail page, while the
  app confirms whether your wallet holds the position, the action area shows
  a disabled "Confirming your role…" button instead of nothing — so a
  borrower mid-repay sees the action is loading rather than an empty space
  under the receipt.

- **Consistent empty-matches state (UX-040).** When the guided matcher finds
  no offers, it uses the same icon + heading empty state as the rest of the
  app instead of bare text.

- **"Post another" (UX-041).** After posting an offer, the success screen
  offers "Post another" beside "View my positions", resetting the flow for a
  fresh offer without leaving the page.
