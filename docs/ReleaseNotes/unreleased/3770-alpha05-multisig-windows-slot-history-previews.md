## Thread — alpha05: multi-signature wallets, approval windows, Auto-lend history and protocol previews (PR #<n>)

The app may be framed by exactly one named origin, the multi-signature wallet's own site, and that list is the only place to change it. The build writes that origin into the frame policy for every path and fails when the policy has no placeholder or the list holds anything but one exact https origin. A subdomain or a look-alike is refused. Framed by anything else, the app shows a refusal and mounts no wallet connection. A browser that hides its ancestors keeps the refusal until the listed parent answers a handshake. Only the manifest and its icon may be read cross-origin, and only by that origin.

Steps a multi-signature wallet approves in rounds now take an approval window the user picks from the ones the step allows: fixed-terms steps offer 30 minutes, 24 hours, 3 days or 7 days, and steps priced live keep 30 minutes. The review says that a signed message and its transaction share one window and need two rounds of approvals. Adopting an asset sent straight to the vault offers 30 minutes or 24 hours, and a multi-signature wallet is told plainly that adopting needs a single-key wallet for now.

An Auto-lend slot now shows its record from the index: how much of the last period its capital was out on loans, and the range of rates comparable loans were agreed at, beside the slot's own minimum. It is labelled as past loans, never a forecast, and suggests no rate. A share the index cannot back says why, a thin sample says there were too few loans to compare, and the lent share stays unavailable until the slot event is deployed.

The cash-out, takeover and instant-borrow reviews now read the protocol's own previews: whether a takeover or a direct sale would be accepted and what each side receives, including any held amount that moves with a sale, and what an instant borrow would give from each source and which sources it would skip, stated as not binding. Late-fee figures in what-if and the accept review come from the protocol's late-fee schedule. Two new refusals have plain words.

Advances #3770; builds on the protocol previews from #3786.

> Caveat: the e2e with real multi-signature wallet contracts on the CI chain, the approve-and-deposit batch, the signed order's cancel note, the adopt resume re-screen and the request-key Telegram link are still to come under #3770; no multi-signature link to Telegram ships before the request key is in.
