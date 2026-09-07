## Thread — the last two unported surfaces, and the cutover that was waiting on them

The connected-app rename left two public-read tools behind on the retired
deployment: the analytics dashboard and the protocol console. That was
the whole reason the legacy host could not be retired — the marketing
site linked to both, and pointing those links at the new app would have
landed visitors on its in-shell not-found page. Both are now built on the
new app, and the marketing site's links follow it.

Neither is a transcription of the retired page. The old analytics screen
read through a stack of hooks that no longer exists; the new one reads
the indexer's public, keyless endpoints — the same ones any third party
can call — because a transparency page whose numbers cannot be
independently reproduced is asking to be trusted rather than checked. It
states the age of the data beside the data, since every figure is only as
current as the last ingest, and it distinguishes a counter the indexer
did not report from a counter that is genuinely zero. On a page whose
purpose is accuracy, an invented zero is worse than an admitted gap.

The protocol console shows every governance-tunable parameter's current
value, read by NAME rather than by position in the config bundle — the
release record already carries an incident where hand-typed positional
tuples silently shifted, and a governance parameter displayed against the
wrong label looks authoritative while being wrong. It holds no controls
and never will: governance changes go through the timelock. The prose
reference stays on the marketing site, where it indexes beside the other
public explainers and is already pinned byte-for-byte against its source;
a third copy would only add something new to drift.

With both ported, the marketing links move to the new app and the helper
that pinned them to the old deployment is deleted — it always said it
existed to be removed rather than become a second permanent surface. The
VPFI call-to-action regained the landing position it promises, and that
anchor is present in BOTH the connected and disconnected states: almost
everyone arriving from that link has no wallet yet, so anchoring only the
connected view would have quietly dropped the majority at the top of the
page — the exact regression the switch was built to prevent.

Two things are deliberately unchanged. The recovery links in the user
guide still point at the old host, because that flow keeps safety state
per origin and moving the links early can let someone broadcast a second
recovery against the first; that turns on state, not on a missing page,
and a redirect does not satisfy it. And the notification-link host stays
where it is, being one decision with the frame paths beside it.

Found while verifying live, and worth recording: both new pages first
rendered empty for the visitors they exist for. They asked the wallet
library which chain to use, and with no wallet connected the honest
answer is Ethereum mainnet — a chain this deployment does not index. They
now use the app's own "where reads land when disconnected" resolution.
