# The installed app's shortcut no longer offers to sell you VPFI

Anyone who installed the lending app to their home screen got a shortcut
labelled "Buy VPFI", described as a way to "acquire VPFI for fee discounts".
The protocol has no purchase surface — that was removed deliberately, for legal
reasons, and the page the shortcut pointed at was renamed at the same time. The
link still worked, because the old address redirects to the new page, so nothing
looked broken from the outside. What survived was the wording, sitting in the
operating system's launcher rather than anywhere the removal had been reviewed.

A shortcut is a stronger claim than a sentence in a document. It is a labelled
entry point a user taps expecting the thing on the label, and it lives outside
the app where nobody rereads it.

The shortcut now says what the page it opens actually is: the VPFI Vault and
Discounts page, for holding VPFI in your vault to earn tiered fee discounts —
the same wording the page itself uses. It points straight at the current
address instead of relying on the redirect.

An internal note in one component described the same page as somewhere you could
"buy and deposit in one flow"; it now describes depositing VPFI you already
hold, and records that the purchase step was removed, so the next person reading
it isn't misled the way this shortcut was.

Installed shortcuts refresh when the app's manifest is next fetched, so existing
installs pick up the corrected label without reinstalling.
