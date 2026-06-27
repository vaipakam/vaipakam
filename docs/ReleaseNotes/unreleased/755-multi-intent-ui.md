## Thread — Auto-lend: multi-intent-per-lender management UI (PR #<n>)

Closes #755 (its second and final PR; the first added the contract read
surface). A lender can run **many** standing auto-lend intents at once —
one per `(lending, collateral)` asset pair — but the dapp only ever showed
the single intent for the pair currently picked in the auto-lend card's
asset selectors. A lender with several intents had no way to see them all,
and a **paused** intent (cancelled but still holding reserved capital) was
effectively invisible unless they remembered its exact pair and re-typed it.

What's new on the Dashboard:

- A **"Your auto-lend intents"** overview card that lists every standing
  intent the connected wallet owns across pairs, each row showing the pair,
  whether it's **Active** or **Paused**, the un-lent **Funded** capital, the
  principal currently **On loan**, the max exposure, and the min rate. It
  pages the new per-owner enumeration, so it surfaces paused intents too —
  the ones a lender most needs a way back to. The card **self-hides** when
  the wallet has no intents, so it never adds clutter for users who don't
  auto-lend.
- A **"Manage"** action on each row that selects that pair into the existing
  auto-lend card and scrolls to it. The list itself is **read-only on
  purpose**: every change — resume, edit, top up, withdraw — still runs
  through the one auto-lend card, which enforces the correct ordered enable
  sequence (consent → keeper delegation → registration → fund). This keeps a
  single, audited write path and avoids duplicating the ordering rules in two
  places.

No protocol behaviour changes — this is a read-and-navigate surface over
state that already existed. There is no borrower-side equivalent: the intent
layer is lender-only by design (borrowers participate through the offer
book).
