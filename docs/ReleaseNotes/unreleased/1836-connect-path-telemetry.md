# Wallet telemetry: the check was watching the wrong moment

An earlier change turned off the analytics phone-home in the wallet
libraries the app embeds — the beacons users never opted into, which also
fill the browser console with errors on locked-down networks. A live check
confirmed the deployed sites were silent, and the work was recorded as
verified apart from one gap: nobody had put a real wallet through an
actual connect.

Closing that gap found something about the check itself.

The wallet library sends nothing while a page loads. It sends when
somebody **picks it** from the connect dialog. Measured against a
deliberately re-broken build: loading the page produced no beacons at all,
opening the dialog produced none, and choosing the wallet produced six
immediately, with two more as the connection completed. The original check
only ever watched the page load — so it was watching the one moment in the
flow when nothing is sent, and would have reported a clean result whether
the setting was on or off.

The new check walks the real path: arrive as a first-time visitor, open
the dialog, choose the wallet and let its software actually start up,
complete a connection, then return as a repeat visitor. On the live site
it is silent at every step. Against the re-broken build it fails loudly.
That pairing is the point — a check that has never been seen failing is
not evidence of anything, and this one had not been.

It also writes down what it cannot see. It stops where the wallet's own
window opens, because finishing a connection there needs a real wallet and
a person.

## The second wallet library, and a check that isn't one

The other way of connecting — the one that shows a QR code for a phone
wallet — was switched on the same day. It appears in the dialog as
**"Other Wallets"** rather than under its own product name, which is worth
knowing: the first version of this check looked for the name, found
nothing, and would have reported the feature missing while it was plainly
working.

Its own privacy setting is a different story, and the honest answer is
that it is **still unverified**. Turning the setting back on and measuring
again produced exactly the same silence as leaving it off — tried twice,
including with genuinely valid credentials so the connection was known to
be healthy. That library evidently only reports home later in a session,
after someone has actually paired a phone. A measurement that reads the
same whether the setting is on or off is not evidence of anything, so the
check records the number and explicitly declines to call it a pass.

Saying "we could not test this" is the point. The alternative — a green
tick standing on a measurement that cannot fail — is worse than an
acknowledged gap, because it stops anyone looking again.

## A privacy beacon that never worked

Separately, the hosting provider had been injecting its own analytics
script into every page, and the site's own security policy refused it on
every load. It gathered nothing while filling the browser console with
errors — errors every review had to read past, which is how genuine
problems hide. It turned out to be a single zone-wide setting covering all
three sites, not a per-site one, which is why nobody found a switch for
this app.

It is off now, and the routine sweep of the deployed site went from
reporting these on every page to **54 of 54 pages clean**. The security
policy carries a note saying the omission is deliberate, so the next
person does not helpfully add it back.
