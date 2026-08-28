## Connected app — the Terms of Service can apply to somebody again

The connected app now asks a wallet to accept Vaipakam's Terms of
Service when a version of them is in force, and holds the app closed
until it does.

That sounds like a feature being added. It is really a control being put
back. The retired app had this gate; the successor was built without it,
and the omission was not visible from either side on its own. Nothing in
the app looked missing, and nothing on-chain looked broken — because the
Terms requirement is one of the few rules the protocol deliberately does
**not** enforce for itself. The contracts record who accepted which
version and publish which version is in force, and they leave the
blocking to the app. So an app with no gate does not degrade the
requirement; it deletes it. Operators could have published terms,
switched them on, and watched every wallet keep transacting without ever
being shown them — with no error anywhere to say so.

What users see depends entirely on whether terms are in force, and today
none are. In that state nothing changes: the app behaves exactly as it
does now, for everybody. The moment operators put a version in force,
anyone with a wallet connected is asked once to accept it, shown the
version and a fingerprint of the exact text, with links to read the
Terms and the Privacy Policy before agreeing. Accepting sends one
transaction — the wallet asks for confirmation and it costs a small
network fee, since the record is kept on chain rather than in the app. Nobody is asked again unless the terms themselves change — and
if they do change, the previous acceptance stops counting, which is the
point of recording a version rather than a tick.

Acceptance is recorded per network. A wallet that has accepted on one
supported chain is asked again on another, because each deployment keeps
its own record and the app can only read the one it is pointed at.

Three deliberate choices are worth stating, because each is a place this
kind of gate usually goes wrong.

**It refuses to guess.** If the app cannot reach the network to find out
whether terms apply, it does not assume they do not. It says so and
offers to try again. The tempting alternative — let people through when
the check fails — would mean the gate stops working precisely when the
network is flaky, which is neither rare nor hard to arrange
deliberately.

**It never blocks getting your money out.** Repaying, claiming and
withdrawing are not behind this. A rule about accepting terms should
never become a reason somebody cannot close a position.

**It does not decide who has accepted.** That question is answered on
chain, by the same contract that holds the terms, which checks both the
version and a fingerprint of the text. Working that out in the app would
have been a second implementation of a rule that already exists, free to
drift from it.

This clears one of the two capabilities that had to exist before users
could be moved from the old connected app to the new one. The other, the
Data Rights export and erase controls, is still outstanding.
