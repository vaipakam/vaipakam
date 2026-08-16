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
