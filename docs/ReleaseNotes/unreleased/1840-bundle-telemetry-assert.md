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

### Why it asks a conditional question

The obvious version — demand the setting be present, always — would report a
problem on a deployment that cannot have one.

The second kit is only included when the app is built with an identifier for
it, and that identifier is substituted at build time, so a build without one has
the entire block removed before it ships. Checking a sibling app turned up
exactly that: the first kit's setting from a single change was present while the
second kit's setting from the same change was simply absent, because there was
no second kit to configure.

So the check asks whether our own configuration block reached the bundle, and
only then requires the setting inside it. The marker it looks for is a detail
only our code passes; the vendor's own library mentions the kit throughout
whether or not our block survived, so those mentions cannot be used to tell.

### Scope

The connected app being promoted is the target that matters, and it passes on
both kinds of evidence. The check still takes any address, so a sibling
deployment can be examined when there is a reason to.

Still outstanding, and not claimed: nobody has completed a real wallet
connection since the settings changed. Configuration and quiet page loads are
both consistent with a connect flow that is broken, and only a person with a
wallet can rule that out.
