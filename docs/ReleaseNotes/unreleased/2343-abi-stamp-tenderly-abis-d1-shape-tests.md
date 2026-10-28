## Thread — stable ABI stamp, build-generated Tenderly ABIs, tested D1 shape rule, Discussions forms (PR #<n>)

The frontend ABI export no longer writes the contracts commit and the
export time into the package's provenance file. Those two lines changed on
every export, so every open branch that touched an ABI conflicted with
every other one there, while the facet JSONs themselves merged cleanly.
The file now lists only the exported facets, which changes only when the
facet set does. The pre-deploy gate already compares every committed ABI
with the compiled one, so a stale export is still refused; it just no
longer carries a timestamp that says when it was made. The keeper-bot
export keeps its commit stamp, because a bot release is correlated with a
contracts state through it.

The hand-captured Tenderly paste copies of the Diamond and timelock ABIs
are removed. The timelock's ABI is now exported from the build with the
other standalone contracts, and the Tenderly alert preset check reads
each preset against the ABI of the contract it watches: Diamond presets
against the combined Diamond ABI, timelock presets against the timelock's
own. Before, timelock presets were not checked at all, and the pasted
copies could drift from the contracts without anything noticing. The
Tenderly README says which generated file to paste.

The indexer's D1 binding check keeps its shape rule (all consumers on one
database, or the cutover barrier with every writer unbound, and nothing
in between) in a small module that unit tests now cover, including the
half-applied barrier that should never occur in production and so was
never exercised. The Base Sepolia internal-match script's second loan now
defaults its price to the one where both mirrored legs have equal LTV, so
the two sides are symmetric unless an operator overrides it, in which case
the script logs the override. Its restore stage no longer looks up the
mUSDC token it does not use.

Discussions now has form templates for Q&A and Ideas, the new-issue page
links to Discussions for questions, and the contributing guide points
questions there instead of at a question-labelled Issue.

Closes #2343, #2650, #2272, #2458 and #131. It also settles item 6 of
#2968: the timelock alert preset is now checked.

> Caveat: the ABI package's provenance file no longer names the contracts commit an export came from; the pre-deploy gate's comparison with the build is what proves the ABIs current.
