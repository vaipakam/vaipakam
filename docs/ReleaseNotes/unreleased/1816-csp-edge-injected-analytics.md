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
page — a worse state that happens to look tidier. The project already applies
exactly this reasoning elsewhere: the connected app disables the wallet
connectors' own built-in telemetry, so that merely opening the connect dialog
does not report usage the visitor never agreed to.

So the policy is unchanged, and it was doing its job — it caught a collector
that had never been declared anywhere in the project. The injection is switched
off at the layer that adds it, which removes the console error at its source.
The policy file and the site's specification now both record why that address
is deliberately missing, so the next person to meet the error does not resolve
it the quick way.

If the product later wants this kind of performance data, it can have it: the
route is through the same consent flow every other category uses, added as a
deliberate choice rather than as a way to quiet a warning.
