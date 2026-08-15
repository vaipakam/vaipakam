# Offer review: the tariff choice resets with the offer, and consent clearing has one owner

Two changes to the offer flow, both about a value being right in the frame it is
shown rather than a moment later.

Choosing a different offer to accept now clears the Full-tariff opt-in
immediately, in the same update that selects the new offer. Previously the
choice was cleared a beat afterwards, which left one moment where the previous
offer's opt-in was still in force against the newly selected one. Because that
opt-in changes what the borrower pays, the receipt in that moment could show a
price that did not belong to either offer. Nothing was submitted from that
state — the moment is shorter than a click — but the figure on screen was wrong
while it lasted, and the reset is now part of selecting the offer rather than a
consequence of it.

Separately, the rule that a changed disclosure withdraws consent is now enforced
in exactly one place. Four older, per-disclosure rules were doing the same work
as the general rule introduced with the consent-and-disclosure gate, each one
acting a moment later than the general rule already had. They agreed with it in
every case, so removing them changes nothing a user can observe; what it removes
is the possibility of them drifting apart in future, where a disclosure added to
one and not the other would be silently unguarded.
