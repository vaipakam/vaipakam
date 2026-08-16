## Thread — the VPFI vault card links to a section that exists (PR #1765)

The "Learn more" link on the VPFI vault overview card pointed at a
tokenomics-spec anchor for a VPFI issuance and buy flow. That section no
longer carries that name: section 3 of the spec is Token Allocation, and the
acquisition and vault material lives in section 8. The link therefore landed
on the wrong part of the document, and its anchor text asserted a purchase
flow that the #687-A securities excision removed. It now points at the
section that answers the question the card is asking.

The three sibling cards on the same surface point at the fee-discount
section, which is a real heading, and were left alone.

This was found while scoping #1742, which asks for the retired `buy-vpfi`
route spelling to be added to the excision ratchet. It is the same shape as
the PWA manifest shortcut that opened that issue: a clickable target whose
label or address asserts a removed surface is the assertion, regardless of
where it happens to land. The rest of #1742 stays open — adding the ratchet
token flags 27 files, most of them stale identifiers whose user-facing copy
is already correct, and choosing between pinning those and renaming them is
a decision recorded on the issue rather than made here.
