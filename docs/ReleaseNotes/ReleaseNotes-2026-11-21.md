# Release Notes — 2026-11-21

Three app-side changes landed. Multi-signature wallets such as a Safe can now use alerts: a request their owners are still approving is accepted for up to seven days, only the browser that started it can finish it, and a request that arrives late never overrides a newer one. The alpha05 app now says that no holding discount applies while a network has no platform token installed. It also cleans every token name and symbol through the shared rule, so a hostile token cannot disguise what sits beside it.

## Agent and app — alert requests from multi-signature wallets

A wallet that needs several owners to approve (a multi-signature wallet such as a Safe) could not use alerts: the signed time goes into the request before the owners are asked, and the alert service refused any request older than ten minutes. Linking or unlinking Telegram, saving alert settings and sending a test alert all failed for such wallets once their approvals took longer than that.

A request whose approval comes only from the wallet's contract on the named network is now accepted for up to seven days after it was made. A signature that recovers to the wallet's own key keeps the ten-minute window, whatever code sits at the address, and no request may be dated more than ten minutes ahead. The one-time record of each accepted request is now kept for the window that applied, so a request cannot be presented twice within it.

Every alert request now names a request key held by the requesting browser: the app draws a random secret for each request, the signed text carries its hash, and the request carries the secret. The service accepts a request only with the key its text names, so only the browser that started a request can finish it. The app keeps the pending request in this browser until the service has answered it (an answer given before the service recorded the request, such as a busy limiter or a check it could not run, keeps it; one rule in the shared library decides this for both apps, and the test alert's cooldown now has its own error name because it comes after the request is recorded), and the Alerts card offers to finish or discard it, says that only this browser can finish it, and states the seven-day limit. The browser's data export shows a pending request but withholds its key, and says so.

With requests that can wait days, two different requests could arrive out of order. Each change is now applied only when no request signed later has already been applied to it, in the same step as the change: link and unlink requests are ordered together per wallet and network (an unlink signed with the wallet's own key, which clears every network, raises the order on every network), and settings saves are ordered on the wallet's settings row (new shared database migration `0116`, a nullable column). An older request changes nothing and the app says a newer one was already applied. The test alert changes nothing and is not ordered. An unlink, applied at once or after a protected-mode wait, still voids any unfinished link code for its wallet and network.

A Safe opened as a Safe App first answers with a proposal rather than a signature. The app now waits for the other owners: it says so, keeps the request, and sends it only once the Safe confirms the approval on chain or its service has the combined signature; if the connected wallet or network changes meanwhile, nothing is sent and the request stays to be finished. Both apps share that rule. A save sent again without a refused Push opt-in remembers that refusal, so finishing it later does not show Push as on. A request that finishes, or that the owner rejects, now drops only itself, never a newer request another tab started for the same wallet, and alpha05 asks for the current Terms before finishing a kept link or Push opt-in, as it does before starting one.

The four signed alert texts changed while the platform is prelive. The other connected app (alpha05) does the same: each alert request names its own key, a request not yet answered is kept in the browser with Finish and Discard on the Alerts page and the seven-day limit stated, and its data download withholds the key and says so.

Closes #3836

> Caveat: a request a multi-signature wallet is still approving can be finished only from the browser that started it, and only while that browser keeps its site data.

_Committed 2026-11-21 23:02 UTC (d1444af42)._
<!-- assembled-fragment: 3836-contract-wallet-alert-requests.md sha256=830e1b1de6025bb04221a8205da7efac0afc3b209978072e73b157bdff85af55 -->

## Thread — alpha05 says no holding discount applies while no platform token is installed (PR #3870)

The platform token arrives with the rewards phase, on every network together, so at launch no network has it and no wallet has a holding discount. alpha05's fee screens now read whether the network reports a platform token. Where it does not, they say that no holding discount applies, instead of offering a discount setting or showing a tier. They do not say every fee is at its full rate, because other reductions, such as a referral's share, still apply and are already in the fee previews.

The fee-discount section on Home, Settings and Rewards shows that line and no toggle. The Rewards page's VPFI section says the token is not installed yet, that it arrives with the rewards phase, and that no holding discount applies to anyone. The lender's discount on a loan, the acceptance review and the rewards widget show the same line in place of their discount figures. The borrow request receipt now says the fee is less any holding discount, which is true with or without the token.

Every screen reads the token through one shared hook, with one set of read options. So a network that has the token installed (a testnet that still carries it) keeps showing the discount, the setting and the tier as before. A read that failed, or whose last refresh failed, makes neither claim.

_Committed 2026-11-21 23:05 UTC (41f627326)._
<!-- assembled-fragment: alpha05-no-hold-discount.md sha256=57a46229dfaf9b6b97f8b1466ab648e09499f5c764f5217d6f361cfb0c6bb9a1 -->

## alpha05 cleans every token name and symbol by the shared rule (PR #3870)

A token's name and symbol are written by whoever deployed it, so a hostile
token could carry a right-to-left override, an invisible character or a line
break to reorder or disguise what sits beside it. alpha05 now passes every
symbol and name through the shared token-label rule as it reads them, from the
token itself, from the public ranking lists and from the platform token's own
facts. Control, bidi and zero-width characters are removed, the label is kept
to one line and capped (20 characters for a symbol, 40 for a name), and it is
shown as plain text, never as a link. A symbol that cleans to nothing shows
the token's short address instead.

Because the rule runs once at the read, every screen that names a token gets
it, and none can show the raw value. The asset-trust check also compares the
cleaned forms, so an invisible character cannot make a copy look different
from the token it imitates.

_Committed 2026-11-21 23:05 UTC (41f627326)._
<!-- assembled-fragment: alpha05-token-labels.md sha256=18306f705e04c07c022a0df7ca63b49027ecf705d854a380b35b806206cef0d5 -->
