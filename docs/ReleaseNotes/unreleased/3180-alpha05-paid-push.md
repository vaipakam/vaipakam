## Thread — alpha05 asks before push alerts can cost anything (PR #3448)

The new app (alpha05) now shows and changes a wallet's agreement to pay for
push alerts. On some networks the alert service charges a small fee in VPFI
for push alerts about a loan. It can charge only a wallet that has agreed on
chain, and only up to the most that wallet agreed to pay.

The Alerts page has a Paid push alerts section. It states the fee per loan
side on this network, set by the protocol, and whether the alert service
charges here. The fee is taken from free VPFI in the wallet's own vault, at
most once per loan side, on the first paid push alert about that loan. A fee
already charged is not refunded, and Telegram alerts are free. The section
warns when the vault holds less free VPFI than the fee.

Agreeing records a cap: by default the fee now, or in Advanced any figure up
to the protocol's ceiling of 50 VPFI. The section says plainly that a fee
rise within the cap is charged without asking again, and that agreeing to
the ceiling accepts any fee governance can set. The agreement is checked and
dry-run before the wallet opens, and the fee is read again just before; if
it moved, nothing is sent. Agreeing asks for the Terms first.

Withdrawing is offered whenever an agreement is stored, whatever the Terms,
a pause or the alert service say. Where the alert service cannot be asked,
agreeing waits. On a deployment without the agreement record, the section
says whether that deployment can still charge the fee.

Advances #3180.
