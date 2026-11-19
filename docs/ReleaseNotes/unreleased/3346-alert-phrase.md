## Alert phrase — Telegram alerts an owner can tell are real

An owner can now set a phrase that only they know, and every Telegram alert from Vaipakam to their wallet starts with it. A message that claims to come from Vaipakam without the phrase did not come from us. The phrase is set from the Alerts card by signing a free message that names it, and removed the same way.

The phrase is kept only in the alert service's private Telegram state. It is never written to the shared database, never logged, never shown back in the app and never kept in the browser. Push notifications never carry it, because a Push channel is not private to the owner.

Scope follows the signer's authority, as unlinking does: an ordinary wallet's signature sets the phrase on every network the service covers, and a smart account's approval sets it on the signed network only. The app says which.

Every change is told to the chats linked where it applied. A first phrase is announced under the new phrase, so the owner sees how alerts will look. A change or a removal is announced under the old phrase, which a phisher cannot know, with advice to turn on protected mode if the owner did not make the change. A chat that is not, or not yet, linked to the wallet is never shown the phrase, so starting a chat move cannot reveal it.

Closes #3346.
