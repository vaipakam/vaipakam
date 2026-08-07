### The last two untranslated messages are filled, and the gap record is closed

Two messages were still shown in English to everyone: the one that says an
offer can no longer be accepted because the person who created it has changed
their own risk settings, and the one that says the deal needs a higher risk
level than the reader's vault currently allows. Both appear at the moment an
acceptance is refused — exactly when a reader most needs to understand why, and
the worst possible place to switch language.

They are now written in all nine offered languages. The instruction that tells
the reader where to raise their risk level names the menu items as that
language actually labels them, rather than the English ones, so someone
following the sentence finds the entry it points at. Each message also ends
with the same reassurance the neighbouring refusal already used in that
language, so the three do not each phrase "nothing was sent or approved" a
different way.

With these filled, the list of known-untranslated entries is empty. That list
was never a place to park things: every entry had to be deleted as it was
filled, and the requirement it was measured against was deliberately never
softened to match whatever happened to be finished. The list shrank from a
hundred and sixty entries per language to two to none, and the requirement now
applies with nothing excused from it.

Filling the list closes one question but not the one people actually care
about. Checking the wording files proves the sentences were written; it does
not prove a reader ever sees them, because each language is fetched separately
while the page is loading and that fetch can fail without anything appearing to
be wrong — the reader simply gets English and no error is reported. So a review
now opens the deployed Recovery page once per language, checks that the wording
file the page actually downloaded is the one this change produces, and confirms
the page genuinely changed language, shows the expected heading, and lays
Arabic out right-to-left.

All nine passed on a build made from this change. They do not pass against the
currently published site, and that is the check working rather than failing:
the published site was built before this change, so it does not yet carry the
two new messages. It will pass there once this is released — which is the point
of checking the downloaded file rather than something that was already correct
beforehand.
