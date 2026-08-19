## An analytics collector nobody asked for was being refused on every page, and it stays refused

A live check of the deployed marketing site turned up an error in the browser
console on every single page load: the site's content policy was refusing a
script. The script was an analytics beacon the hosting provider inserts into
responses automatically, as a zone-level setting — nothing in the site asks for
it, and nothing in the site can control it, because it is added after the page
leaves the application.

The obvious fix — permit that one address in the policy and the error goes away
— is the wrong one, and the reason is worth stating because the error is
annoying enough to invite it.

The site's rule is that no analytics runs until the visitor has agreed to
analytics. That is enforced in the application, around the analytics the
application loads. A collector inserted after the fact sits outside that
enforcement entirely: it cannot be held back until consent, because the code
that would hold it back never sees it. Permitting it would therefore have
traded a visible console message for an unconsented collector running on every
page — a worse state that happens to look tidier. The project's rules already
extend this reasoning beyond its own analytics: the connected app's wallet
connectors are required to have their built-in telemetry switched off, so that
merely opening the connect dialog does not report usage the visitor never
agreed to. Checking that requirement while writing this turned up that neither
of the two connectors it names actually switches its telemetry off, and that
both therefore report to their vendors — not when someone opens the connect
dialog, as first assumed, but as soon as the app loads at all, because the app
restores any previous wallet session on start-up and building each connector to
check is what starts its reporting. So the exposure covers every visitor to the
connected app, not only those who reach for a wallet. Both are recorded
separately as their own gap.

So the policy is unchanged, and it was doing its job — it caught a collector
that had never been declared anywhere in the project. The policy file and the
site's specification now both record why that address is deliberately missing,
so the next person to meet the error does not resolve it the quick way.

The console error itself is **not yet gone**, and nothing in this change makes
it go: the beacon is added by the hosting configuration, not by anything in the
project, so it stops only when an operator turns that setting off for the site.
Until then the browser console keeps showing the refusal — which is the safe
state, since the refusal is what prevents the unconsented collector from
running.

If the product later wants this kind of performance data, it can have it: the
route is through the same consent flow every other category uses, added as a
deliberate choice rather than as a way to quiet a warning.
