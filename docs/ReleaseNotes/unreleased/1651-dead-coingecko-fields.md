## Chain configuration — two settings for a page that no longer exists (PR #TBD)

Every chain the apps know about carried two extra settings: a link target for
the chain's native gas token, and one for its bridged wrapped-ether token. Both
existed for a single purpose — the removed VPFI purchase page used them to link
the asset name a user was paying in to the right reference page, which mattered
because the "same" wrapped token is a different contract on each chain.

That page and the helper that read these settings were removed some time ago
for legal reasons. The settings were not. They stayed declared in three
packages and filled in for all thirteen chains, with nothing anywhere reading
either of them.

This removes both. It is deletion of data that no longer feeds anything, not a
change to what any chain does — the values were never displayed after the page
that displayed them was withdrawn.

Two judgement calls worth recording:

A third setting added at the same time and for the same page — the chain's
native gas symbol — is **kept**. It is also declared in the newer connected
app's own chain list, so whether it is still wanted is a separate question from
this cleanup, and answering it here would have quietly widened a tidy-up into a
change to a different application.

A comment on the BNB chain entry described a constraint the removed purchase
contract had to satisfy, and a deployment check that enforced it. Both are gone,
so the comment documented a rule nothing can apply. Replaced with a note saying
what it described and why it went, rather than deleted outright — silently
removing it would re-open the question of why the constraint is absent.

Historical references elsewhere — in the task list, older release notes, and a
chain-safety audit — are deliberately untouched. They are accurate records of
work that happened.

No user-visible behaviour changes.
