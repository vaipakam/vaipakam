## The wallet-analytics check now also reads what actually shipped

The check that watches for wallet kits phoning home could only ever speak for
one of the two kits. The other is never started when the app loads, and even
when it is, it stays quiet on a first visit — it forwards only what an earlier
session left behind. Its setting could therefore have been switched back on and
every observation would still have come back clean. The check said so plainly
rather than implying coverage it did not have, and the gap was recorded as work
of its own.

That gap is now closed from the other side. Alongside watching the traffic, the
check reads the JavaScript the deployed app actually serves and confirms both
kits' settings are present in it. No wallet and no returning visitor required.

The two kinds of evidence are reported separately, on purpose. Watching traffic
shows behaviour. Reading the shipped code shows configuration — it proves the
setting was published, not that the vendor honours it. Presenting either as the
other would overstate what was established, which is the mistake this whole
line of work exists to avoid.

### Why it refuses to excuse a missing setting

The tempting version of this check would let a deployment off when it has no
second kit to configure — that kit is only included when the app is built with
an identifier for it, and a build without one has the whole block removed before
it ships. An earlier draft tried exactly that, and the attempt could not be made
sound: the wallet library generates its own near-identical configuration, so any
signal claiming "our settings block is present" can be produced by library code
instead.

So the check does not guess. It confirms a setting is there, and when one is
missing it says so plainly, naming both possible reasons and leaving the
judgement to a person. That direction is the safe one: a deployment that
legitimately omits the kit costs someone one look, whereas excusing absence
automatically would have excused a genuine regression on exactly the same
evidence.

### Scope

The connected app being promoted is the target that matters, and it passes on
both kinds of evidence. The check still takes any address, so a sibling
deployment can be examined when there is a reason to.

Still outstanding, and not claimed: nobody has completed a real wallet
connection since the settings changed. Configuration and quiet page loads are
both consistent with a connect flow that is broken, and only a person with a
wallet can rule that out.
