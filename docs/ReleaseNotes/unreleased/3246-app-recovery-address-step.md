## App — the recovery address step on Vault protection (#3246 part 2)

Protected mode now refuses to switch on until the account has a recovery
address, the one place a clawback pays. The connected app had no way to set
one, so "Turn on protection" failed for every account. The Vault protection
page now has a Recovery address step before it, and the switch-on button
stays unavailable, with a sentence saying why, until an address is set or
waiting.

The owner names the address and gets a signing link for it. The recovery
wallet opens the link and signs a proof that it is controlled. Signing sends
no transaction, so a cold or empty recovery wallet needs no gas. It then gets
a link back, and the owner opens that link and sends the request. Both links
use one parameter format, defined once in the shared library and used by
alpha05 too. Before sending, the page checks that the proof belongs to this
account, vault and network, that the named wallet signed it, and that it has
not expired or been used, and it states how long the address will wait. A
first setting waits twice the payout delay, and a change waits 30 days. The
card shows the address in force and any waiting one with the time it comes
into force, and the owner can cancel the waiting one.

Starting a clawback is not in the app yet, and the card says so.

The protocol console's matcher fee row now says what the rate applies to:
the initiation fee's part above the treasury floor, counted before any
referral cut.

The fork-tier spec for protection drives the whole hand-off with a second
test wallet. It does not seed the address on chain.
