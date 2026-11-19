## Thread — alpha05: unrecognised items, position token approvals, outflow alerts, lending kit (PR #<n>)

What reached a vault outside the protocol is listed apart from the wallet's own assets on the Vault page, closed by default with its count. The index finds candidates; the chain decides what is shown, at one block, and only the vault the protocol names. A token's own name is shown as plain text beside its address, never as a link or image. Recover lists the same items to pick from and suggests neither choice. No alert is sent for these on purpose: an alert would itself be the lure.

A position token approved for transfer to another address is now named, with the whole address, on the position it belongs to, to the wallet that holds it, with one step that removes the approval. The inbox has words for the two new approval alerts. When protected mode is switched on but the second prompt, the token lock, does not land, the outcome says "Protected mode is on. Your position tokens are not locked", and the card offers the lock on its own. The switch-on stays two wallet prompts until a deploy carries the single-transaction form.

The alerts card offers a choice for messages when something leaves the vault: Default (on while protected mode is on), Always or Never.

A new workspace package, the embedded lending kit, builds the link that opens the platform's own borrow, lend or rent review for an integrator's user. It holds no key and signs nothing; the app reads the link with the same parser.

That link now lands on a page of its own. It says what the link asks for, which network it is for, and which app it names, with the integrator registry's answer read from the chain: active, suspended, not registered, or unread. Continuing opens Borrow, Lend or Rent filled in from the link, with a notice the user can act on: remove the named app from what they sign, or stop using the link. On a borrow, the review states what the protocol would pay that app today, or why nothing; on a lending offer, that naming it is a record only; a rental names no app.

Closes #3435, Advances #3721, #3434 and #3773
