### alpha02: UX trust batch 1 — six review findings fixed

First fix batch from the 2026-07-11 whole-site UI/UX review
(UX-001/002/007/020/021/022):

- A loan that is already over no longer shows a live amount owed or
  the "if the borrower does not repay…" default warning. The receipt
  now answers per outcome — repaid, defaulted, or closed — and the
  consequence row becomes "What happens next" with matching guidance.
- Claim Center cards now show the exact amount each claim pays out
  (read from the contract's own claim record), replacing "+ interest"
  and the vague default-recovery description.
- On phones the floating Support button moved to the bottom-left so it
  can no longer cover a card's Claim / Use-this-offer button.
- The connected-wallet chip no longer wraps the address onto two lines.
- "Couldn't load" states on Positions, Claims, and the rental browse
  now include a working "Try again" button instead of only telling the
  user to retry.
- Loading indicators actually spin.
