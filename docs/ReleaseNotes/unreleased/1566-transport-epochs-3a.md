## #1566 transport epochs, first change — the attested split, and every arrival's day-list commitment (PR #TBD)

The cutover's second part let an administrator classify a protected packet's
value, and bounded a fresh classification by evidence the administrator
cannot write: what the packet's source chain recorded of its split. Nothing
on a live deployment could supply that evidence, so an untyped arrival could
be classified recycled only. This change supplies it — recorded for later
rather than consulted yet — and records one more fact about every arrival
that the transport epochs' ledger will need.

**The attested split.** The canonical chain can send, for any remittance it
issued, the split it recorded when it sent: the fresh figure and the recycled
figure, toward the chain that remittance went to. Anyone may ask it to. The
content is the chain's own record, so a caller can neither forge nor inflate
it, and the caller pays the transport fee, which the platform quotes
beforehand. The mirror that received the remittance resolves it through the
receipt the delivery created and keeps both figures once, each scaled down to
what actually landed in the same proportion, so a short delivery shrinks both
and never leaves one larger than the whole. It refuses what it cannot
honestly attest: a packet whose wire already carried its split, a receipt
whose delivery came from a chain other than the attesting one, a receipt that
predates packet stamping, an empty split, and a second attestation that
disagrees with the first — the first record is the source's, and a differing
one is a faulty source rather than a correction. A second attestation that
says the same thing changes nothing and is accepted, because asking again is
how a sender handles a delivery it cannot confirm, and the transport fee is
paid whether or not the message lands. A refused message stays re-executable,
so a repeat send is a retry, not a grief.

Only a remittance that carried its own identity on the wire can be attested.
The oldest wire shape carried none — no receipt exists for it, and the
canonical chain holds no reservation — so such a packet's fresh component
stays unauthenticated for good: it classifies recycled, or leaves untyped
through the dispositions the epoch already provides.

**Recorded, not yet consulted, and never frozen.** The two attested figures
sit beside the packet and are never changed afterwards. What a classification
may treat as evidence is worked out from them at the moment it is asked,
never written down in advance at some earlier step — because asking the
canonical chain to attest is open to anyone, and so is the step that later
releases a packet's value for classification, and the two can happen in
either order. A figure frozen before the attestation arrived would read as
"no evidence" for ever, for exactly the packets the attestation was sent to
evidence. Today the release step does not exist yet, so the answer is the
same as it was before this change: an attested packet still classifies
recycled only. The transport epochs' ledger, the next change, is what makes
the answer move.

**Every arrival commits to its day list.** A packet on any wire before the
next wire version names the days it funds. The mirror's ingress now records,
with the packet and in the same transaction, a fingerprint of that list and
its length. Nothing reads them yet. They are what the transport epochs'
ledger will check a re-supplied day list against when it admits a packet,
so a packet that landed before that ledger existed is never admitted on the
strength of an event, only of the chain's own record. A compensation
delivery, which names one day, is committed the same way.

**The mirror-side ingress has its own facet.** The three entries the
transport calls on a mirror — the budget delivery, the compensation delivery
and the compensation-day hook — moved unchanged out of the remittance facet,
which had almost no room left under the platform's per-facet size limit, into
a facet of their own, because the ingress is exactly where this family of
changes and the role carry-forward after it will grow. Every caller reaches
them by the same identifiers through the same entry point; only the code
behind them is separate, and a refresh must carry the two together. The one
derivation of a delivery receipt's key, which four places had copied byte for
byte, now lives in one place.
