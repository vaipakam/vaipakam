## alpha02 — stuck-token recovery page (PR #<n>)

The main app's stuck-token recovery utility now exists on the alpha02
site too, rebuilt in its plain-language style. It returns ERC-20
tokens that landed in a user's vault address outside the app (a
mistaken direct transfer, or "dust" a stranger sent) to the connected
wallet — such tokens are never part of any deal and never affect
balances or positions.

The page is deliberately unlisted, exactly like the original: it has
no navigation or Settings entry, search engines are told to ignore
it, and the only way in from inside the app is a new explainer card
on the Help page that first spells out the danger — if the sender a
user declares turns out to be sanctions-listed, their wallet is
flagged and blocked from every new-position action (creating or
accepting offers, deposits, recovery and the like), not just from
this page. Existing loans can still be repaid and closed, and the
block lifts automatically if that address is later removed from the
sanctions list. That is the "dust poisoning" trap the explainer
warns about, and reading it before finding the button is the safety
design, not an oversight.

The flow itself keeps every deliberate speed bump: declare the token,
the sender (a wallet you control), and the amount — capped at the
provable surplus sitting in the vault beyond what the protocol
tracks; review the declaration next to the standing warning; type
CONFIRM to arm signing; sign a typed acknowledgement; and the outcome
is read from what actually happened on-chain, distinguishing a
successful return-to-wallet from the flagged-wallet outcome (which
the page explains honestly, including that the block lifts
automatically if the flagged address later leaves the sanctions
oracle's list).

One honest gate the original relied on documentation for is now
explicit in the page itself: recovery depends on the protocol's
screening service, and on a network where that service isn't
configured yet the page says recovery isn't available — instead of
letting anyone sign a transaction that could only fail.

An automated end-to-end test drives the real contract on a forked
network: dust is minted straight into a vault, the Help explainer's
link is followed, and the recovery round-trips with the tokens
verified back in the wallet.
