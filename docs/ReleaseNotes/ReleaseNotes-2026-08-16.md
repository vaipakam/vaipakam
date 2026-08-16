# Release Notes — 2026-08-16

Two entries, both cleaning up after the securities excisions on user-facing
surfaces rather than in contract code.

The first repairs the tokenomics "Learn more" links, which had been serving a
404 from a base URL that never followed the specification to its new home —
and, underneath that, two anchors pointing at sections describing removed
programmes. The two are separate excision tracks: the fixed-rate VPFI sale was
removed in #687-A, the `5% APR` staking yield in #687-B. The second entry
removes the retired buy widget's strings from the marketing site's translation
bundles, where seven languages still carried a "Buy VPFI" label for a surface
that no longer exists — the #687-A one. Nothing rendered those strings; they
shipped in the bundle regardless.

## Thread — the tokenomics help links point at a document that exists (PR #1765)

Every "Learn more" link on a card that cited the tokenomics specification was
serving a 404. The base URL still addressed the spec at its old top-level
path; the document now lives under the functional-specs directory, and the
constant had not followed it. Ten links were affected.

Two anchors were stale on top of that. The VPFI vault overview card pointed
at a section named for a VPFI issuance and buy flow — a surface the #687-A
securities excision removed — where the acquisition and vault material is now
section 8. The dashboard rewards summary pointed at a rewards section that
does not exist; section 7 is the *removed* staking-yield program, so once the
base URL was corrected that link would have taken a reader to a retired
programme. It now points at platform interaction rewards, which is what the
card describes.

Every remaining anchor was checked against the specification's actual
headings and resolves.

The card help file also carries seven links to numbered README sections that
no longer exist — the README was shortened and those sections went with it.
Those are left alone here: unlike the tokenomics links there is no
corresponding heading to repoint them at, so each needs a decision about
where it should lead. That is filed separately.

The first of these was found while scoping #1742, which asks for the retired `buy-vpfi`
route spelling to be added to the excision ratchet. It is the same shape as
the PWA manifest shortcut that opened that issue: a clickable target whose
label or address asserts a removed surface is the assertion, regardless of
where it happens to land. The rest of #1742 stays open — adding the ratchet
token flags 27 files, most of them stale identifiers whose user-facing copy
is already correct, and choosing between pinning those and renaming them is
a decision recorded on the issue rather than made here.

## Marketing site — the retired VPFI buy widget's strings leave the translation bundles

The public marketing site's VPFI page once carried the interactive
deposit/withdraw widget. That widget moved to the connected app, but its
strings stayed behind in the marketing site's translation bundles: connect
prompts, unsupported-network notices, the three numbered step headings, and
the button labels and failure messages for every action it used to offer.

Twenty-five keys in all, none of them read by anything the marketing site
renders — the page uses only its title and the pre-connect explainer. They
shipped to every visitor regardless, in the English bundle that loads on
first paint and again in each translated bundle.

Four of them named a purchase — a button reading "Buy VPFI", its in-flight
and failure counterparts, and a timeout notice about returned funds. The
English copy on this page had already been reworded away from purchase
language by the securities excision, but these particular strings were part
of the widget rather than the page, so the rewording never reached them, and
seven of the translated bundles still carried the purchased-verb phrasing
their translators had been given. Nothing rendered them; they were
nonetheless the removed surface, asserted in the shipped bundle.

All twenty-five are gone from all ten language bundles. Nothing the page
displays changes.

While confirming which keys were dead, a larger version of the same drift
came into view: the marketing site's bundles carry fifty-four further
namespaces that belong entirely to the connected app — well over a thousand
strings the marketing site never renders. That is filed separately; this
change stays inside the one namespace the page actually uses.
