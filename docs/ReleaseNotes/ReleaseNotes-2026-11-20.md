# Release Notes — 2026-11-20

A quieter day while contract changes wait to be released together. The vault owner gained a recovery claim: a nominated recovery address can ask to move the vault's holdings, and the move runs only after the owner's waiting period. The alpha05 app grew a group of holder tools, covering items that reached a vault from outside, position-token approvals, outflow alerts, multi-signature wallets, approval windows, Auto-lend history and protocol previews, and reward claims now always land in the vault. The app no longer shows a fee discount before the rewards phase brings the platform token. Token names and symbols are now cleaned by one shared rule everywhere they are shown.

## Thread — alpha05: unrecognised items, position token approvals, outflow alerts, lending kit (PR #3806)

What reached a vault outside the protocol is listed apart from the wallet's own assets on the Vault page, closed by default with its count. The index finds candidates; the chain decides what is shown, at one block, and only the vault the protocol names. A token's own name is shown as plain text beside its address, never as a link or image. Recover lists the same items to pick from and suggests neither choice. No alert is sent for these on purpose: an alert would itself be the lure.

A position token approved for transfer to another address is now named, with the whole address, on the position it belongs to, to the wallet that holds it, with one step that removes the approval. The inbox has words for the two new approval alerts. When protected mode is switched on but the second prompt, the token lock, does not land, the outcome says "Protected mode is on. Your position tokens are not locked", and the card offers the lock on its own. The switch-on stays two wallet prompts until a deploy carries the single-transaction form.

The alerts card offers a choice for messages when something leaves the vault: Default (on while protected mode is on), Always or Never.

A new workspace package, the embedded lending kit, builds the link that opens the platform's own borrow, lend or rent review for an integrator's user. It holds no key and signs nothing; the app reads the link with the same parser.

That link now lands on a page of its own. It says what the link asks for, which network it is for, and which app it names, with the integrator registry's answer read from the chain: active, suspended, not registered, or unread. Continuing opens Borrow, Lend or Rent filled in from the link, with a notice the user can act on: remove the named app from what they sign, or stop using the link. On a borrow, the review states what the protocol would pay that app today, or why nothing; on a lending offer, that naming it is a record only; a rental names no app.

Closes #3435, Advances #3721, #3434 and #3773

_Committed 2026-11-20 07:50 UTC (fd8e79548)._
<!-- assembled-fragment: 3435-alpha05-unrecognised-approvals-kit.md sha256=be044eb46e28045bca4b04b04020b21a3bd648411f9f8dae7ff15cf7d6285d22 -->

## Security — the recovery claim (PR #3817)

A protected account can now let its recovery address ask for the account after
a wait the owner chooses, so an account with no signer still has an exit when
its owner key is lost or its owner is gone. The claim is off by default. The
owner switches it on, with a wait of 30 to 365 days between a request and the
earliest run. Switching it on, or shortening the wait, waits the account's
delay like every other loosening change; switching it off, or lengthening the
wait, applies at once, also on a locked account. Switching protected mode off
switches the claim off.

Only the recovery address in force may ask, and not while a change of
recovery address is pending. A request is accepted on a locked account, since
the clawback is the way out of one. Its dates are fixed when it is asked: it
may be run from the end of the wait until 30 days later, when it lapses and
must be asked again. Nothing on the account is frozen while a claim is open. A claim belongs to the address
that asked: once a change of recovery address is in force, the replaced
address's claim is void, and the new address asks for itself, at once and with
the full wait.

The owner or any signer may cancel an open claim at any time before it runs,
also while the account is locked and while the platform is paused. A lock, a
replacement and a clawback each end it. So does any write to the protected
record that the owner's key sends itself, because that shows the key is still
held. A write submitted on the owner's signature by someone else does not: a
signature can be kept and submitted later. After a claim is cancelled or
dropped, a new request waits 30 days, so a stolen recovery key cannot keep
re-alerting the owner; a lapse starts no such wait.

Only the recovery address runs a matured claim. The run is the existing
clawback, unchanged in what it moves and the state it leaves, recorded with
its own trigger value ("recovery claim", 3). The platform refuses the run
while it is paused (escape window or not) and until 24 hours after the end of
the price guard's latest sequencer outage window, failing closed when that
window cannot be read; on a network with no sequencer the check does not
apply. The owner's and the signers' own clawback is unchanged.

The design is `docs/DesignsAndPlans/RecoveryClaimDesign.md`; the clawback
design records the amendment to its "manual only" decision. The alerts for an
open claim are the keeper thread's work and ship disarmed. The app's prompt,
setup warning and recovery-address view follow separately.

Closes #3756

> Caveat: a pause or an outage can cost the last days of a claim's run window; the lapse date does not move.
> Caveat: a stolen owner key can cancel every claim; signers and the clawback remain the defence there.

_Committed 2026-11-20 01:20 UTC (99195f4cf)._
<!-- assembled-fragment: 3756-recovery-claim.md sha256=b8ebd0f7d07edc75b0685247b8717d0ac46e2c110afe71d61de4071544b8a094 -->

## Thread — alpha05: payers, watchers, goals and a loan given away (PR #3806)

A reader who holds neither side of a running loan now sees who holds the borrower position, read from the chain. Where the position moved, the payer confirms whom a payment benefits before Repay opens, and a change of holder before signing stops it. Such a reader can also ask for Telegram alerts about the loan; watching gives no right over it. A loan link names its network, and a wallet on another network is told so rather than shown a different loan with the same number.

The holder of a running loan's lender side can give it to another wallet through a guided transfer. The review states what the receiver gets (later repayments and the end claim, into the receiver's own vault, after anything still owed to earlier sellers) and what stays with the giver. Goals on Positions name a target amount and date for loans the wallet lent or an Auto-lend slot; they lock nothing on chain, and progress is never shown from a partial read.

Borrow takes an optional "for someone" address, the app's own note only: every review states the borrower's collateral secures the loan and the other person is not bound. Positions shows a lending ladder. A range offer under Advanced takes its second rate, and the review says a match settles at the middle of the overlap.

Every write and signature now checks the wallet's live account and network when it is made, so nothing is prompted, sent or recorded for a wallet or network other than the one reviewed. The asset line states the issuer-power checker's findings once a run is stored, and a request pledging an NFT simulates the move to the vault first. Observed rates count the loans left out as unconfirmed beside each figure.

Closes #3769, Closes #3771, Closes #1691, Closes #2525; advances #3770

_Committed 2026-11-20 07:50 UTC (fd8e79548)._
<!-- assembled-fragment: 3769-alpha05-holder-and-watcher-tools.md sha256=1e4e44e912e4f57b364d8dd51e469b4942c604929b0678abbdc19c90263eb838 -->

## Thread — alpha05: multi-signature wallets, approval windows, Auto-lend history and protocol previews (PR #3806)

The app may be framed by exactly one named origin, the multi-signature wallet's own site, and that list is the only place to change it. The build writes that origin into the frame policy for every path and fails when the policy has no placeholder or the list holds anything but one exact https origin. A subdomain or a look-alike is refused. Framed by anything else, the app shows a refusal and mounts no wallet connection. A browser that hides its ancestors keeps the refusal until the listed parent answers a handshake. Only the manifest and its icon may be read cross-origin, and only by that origin.

Steps a multi-signature wallet approves in rounds now take an approval window the user picks from the ones the step allows: fixed-terms steps offer 30 minutes, 24 hours, 3 days or 7 days, and steps priced live keep 30 minutes. The review says that a signed message and its transaction share one window and need two rounds of approvals. Adopting an asset sent straight to the vault offers 30 minutes or 24 hours, and a multi-signature wallet is told plainly that adopting needs a single-key wallet for now.

An Auto-lend slot now shows its record from the index: how much of the last period its capital was out on loans, and the range of rates comparable loans were agreed at, beside the slot's own minimum. It is labelled as past loans, never a forecast, and suggests no rate. A share the index cannot back says why, a thin sample says there were too few loans to compare, and the lent share stays unavailable until the slot event is deployed.

The cash-out, takeover and instant-borrow reviews now read the protocol's own previews: whether a takeover or a direct sale would be accepted and what each side receives, including any held amount that moves with a sale, and what an instant borrow would give from each source and which sources it would skip, stated as not binding. Late-fee figures in what-if and the accept review come from the protocol's late-fee schedule. Two new refusals have plain words.

Borrow now also asks how the lenders are chosen: best rate, the cheapest first, or fewest lenders within a rate difference the borrower states, which means fewer loans and less gas at a rate that can be a little higher. The review says how many lenders the list uses and the rate across them, and what the other choice would change, estimated from what was read; it recommends neither (the borrowing design, PR #3809, section 12).

Advances #3770; builds on the protocol previews from #3786.

> Caveat: the e2e with real multi-signature wallet contracts on the CI chain, the approve-and-deposit batch, the signed order's cancel note, the adopt resume re-screen and the request-key Telegram link are still to come under #3770; no multi-signature link to Telegram ships before the request key is in.

_Committed 2026-11-20 07:50 UTC (fd8e79548)._
<!-- assembled-fragment: 3770-alpha05-multisig-windows-slot-history-previews.md sha256=92ea352e2e469354d1fec98560b982e0da33706b7de2b2d4b330e40d72a70e51 -->

## alpha05: reward claims always land in the vault

The payout rule (owner decision 2026-11-19) pays every reward into the claimant's vault as free balance, and the contracts refuse the wallet delivery from #3805. The app now claims with the vault in every case. Before, it sent a contract wallet's claim to the wallet and let Advanced mode pick the wallet, and the contracts would now refuse both.

Advanced mode no longer offers a destination choice. It shows one line, "Rewards land in your vault, ready to use. Withdraw moves them to a wallet.", with the note on whether vault VPFI counts toward the fee-discount tier on this network. The review's destination line says the reward arrives as free balance, that Withdraw moves it to a wallet, and that a vault is opened for a claimant who has none. With protected mode on, it adds that a Withdraw to a wallet waits the delay. While the mode cannot be read, it says so instead of assuming either answer.

The finished claim is still measured from its own transaction, so the outcome names where the VPFI actually arrived.

Caveat: the line about opening a vault describes the contracts from #3805. Ship this with the deploy that carries #3805.

Closes #3807.

_Committed 2026-11-20 07:50 UTC (fd8e79548)._
<!-- assembled-fragment: 3807-alpha05-reward-claims-vault-only.md sha256=1a5c35bfd6175fdf39917cff3f06d423e602a2a52d3362ed132c5e4fceeeab4c -->

## App — no fee discount shown before the rewards phase

The platform token now arrives with the rewards phase, so no network has it at launch and every fee is charged at its full rate until then. The app says this plainly wherever it used to suggest a discount.

On a network whose Diamond reports no platform token, the VPFI page shows a single notice. It says the token is not installed there, that it arrives with the rewards phase on every network together, that no fee discount applies to anyone until then, and that everything works without it. The page no longer shows the discount explainer or offers to switch to another network, because no network has a discount to give. A failed check still says it could not check.

The protocol console still lists the configured discount tiers, because they are real settings. On such a network it now adds a line saying none of them applies and every fee is charged at its full rate.

The Help answer to "Do I need VPFI?", the VPFI line in the settings menu and the VPFI page's search description now say discounts start with the rewards phase and fees are at full rate until the token is installed.

_Committed 2026-11-20 05:05 UTC (c35eb7ed3)._
<!-- assembled-fragment: launch-no-token-discount.md sha256=a50146c0a66a6f7b6a7e3f6b35f8c2ad75479361a887101501eb52a93a0276b2 -->

## Indexer, agent and app fixes — one cleaning rule for token names and symbols

A token's name and symbol are written by whoever deployed the token, so every surface that shows or exports one is to clean it with one shared rule in the shared library, instead of each surface keeping its own. The rule removes control and format characters (the bidi overrides that can visually reorder an address beside the label, zero-width characters, line breaks), keeps the label to one line, and caps its length at 20 characters for a symbol and 40 for a name. The result is always plain text, and a surface never renders it as a link.

For exports there is one more step: a label starting with `=`, `+`, `-` or `@` gets a leading apostrophe, so a spreadsheet opening the file reads it as text and never as a formula. The statements card and the public data feed, neither of which has shipped yet, are to use this export form, and alpha05 imports the same rule from the shared library.

The stuck-token recovery page, which had its own narrower version of the rule, now uses the shared one. It also removes the other Unicode format characters and folds line breaks to a space.

The rule comes from the design security review of the statements card and the public feed. Alerts carry no token names, so nothing live was exposed.

_Committed 2026-11-20 05:28 UTC (e2ac60d80)._
<!-- assembled-fragment: token-label-rule.md sha256=70d8c03de4e7c3ec95031d686caa7a4cc6a56960a28d15f1e2d4dce9b0ba19b0 -->
