## Connected app — the admin check and the accept preflight stop lagging a frame (PR #1756)

Two more lookups get the treatment from PRs #1753, #1754 and #1755.

The admin check decides whether protocol-administration controls appear. It
reset itself only after the page had drawn, so on disconnecting a wallet, or
switching to a network where that wallet holds no administrative role, the
controls stayed on screen for a moment for someone who no longer had the role.
The on-chain role check has always been the real boundary and is unchanged —
nothing could have been done with those controls — but showing them at all is
misleading.

The accept preflight is the check the accept modal runs before letting an offer
through. It kept the previous offer's verdict while the new offer's check was in
flight, so opening the modal on a second offer briefly showed the first offer's
answer against it. That verdict is what drives the modal's blocking messages,
so the wrong one is the difference between "you may accept this" and a specific
reason you may not.

Both now label the answer with the whole question — which network, which wallet,
which offer — and work out at drawing time whether the label still matches.
The preflight's label also includes its explicit re-check counter, so the
re-check that runs after recording an acknowledgement cannot be satisfied by the
answer taken before it; that call exists precisely to get a fresh verdict.
