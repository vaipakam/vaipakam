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
a person. And the second wallet library is not part of this app's build at
all right now — so rather than quietly passing a test with nothing behind
it, the check states that absence and fails if that ever changes, so an
untested way of connecting cannot reach people unnoticed.
