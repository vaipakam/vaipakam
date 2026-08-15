## Four contract comments corrected, each describing something the code does not do

Two review passes over the admin runbook found that several claims a published
operator page was making came straight from contract comments, and that the
code did not support them. The comments were the root cause, so this change
corrects them at the source. Nothing about how the protocol behaves changes.

**A note on scope.** This started as a larger sweep that also covered the
cross-chain channel-peer map, on the finding that comments described an
identity check the receiving side did not perform. That half is **withdrawn
rather than merged**: separate work has since built the check, so the comments
this change would have corrected became accurate again on their own, and
"correcting" them now would have introduced the very kind of false statement
the sweep exists to remove — in the opposite direction. The remaining four
corrections are unaffected by that work and are still needed.

### The reward-configuration field is not zero on the canonical chain

A field recording which network is the canonical one was documented as being
left empty on that network itself. It is not: the deployment scripts set it on
every network, canonical included. The wrong description had already caused a
correct deployment to be written up as configuration drift.

The claim had propagated. It appeared in the field's own description, in a
guard elsewhere that cited it as the reason for reading the network's identity
directly rather than from the field, and in the commentary of the test covering
that guard. All are corrected. The guard itself is still right, and now for a
better reason than the one recorded: the field is administrator-settable, so a
check reading it to decide "am I the canonical network?" could be switched off
by a governance write, whatever the deployment happens to configure.

### The price anchor named as the single source of a rate is one of three

A keeper-reward constant described itself as the place a particular
VPFI-to-ETH rate is stated. Two other places express the same relationship for
different features, and none of the three reads the others — so changing one
does not move the rest. Someone repegging from that constant would have
concluded they had found the only one.

The three are not alike, which is the part worth carrying: two are fixed values
compiled into the contracts, while the third is a runtime setting with no
built-in value that governance can change at any time. That third one is the
only one that can quietly come to disagree with the others on a live
deployment. Its value for one test network is documented in the deployment
runbook — but a runbook records what an operator is instructed to do, not what
the network currently holds, and the corrected text is careful about the
difference.

### An unchecked operator input leaned on an enforcer that had been deleted

An oracle setter justified accepting an unverified address by pointing at a
policy enforced elsewhere. That elsewhere was removed in an earlier legal-scope
excision, along with the feature it governed, so the guarantee this setter
relied on had no enforcer anywhere. It also cited a section of the repository
guide that no longer exists.

This is the most dangerous shape a stale comment takes: it makes an existing
check appear to be part of a pair, so whoever audits it next goes looking for
the other half and finds nothing. The setter now states plainly that nothing
enforces the choice, that it is the only surface, and that the operator must
verify the address against the chain's official bridge registry — naming the
registry rather than any internal document as the source, after three
successive replacements each pointed somewhere that had gone.

### Residue from a removed feature described it as live

A storage-structure section header for the removed fixed-rate purchase surface
outlived its own fields and was left labelling unrelated entries beneath it,
its sentence cut off mid-clause. Removed, with a note recording why, so the
next reader is not left wondering what used to be there.

### A storage slot was specified, shipped, and never built

A field for a cross-chain "authorised peer" was allocated, released, and
documented in a design document as validated on arrival. Nothing in the code
reads or writes it. The specified check was never built.

The slot's description now records that plainly. Since this change was first
written, separate work has built equivalent authentication one layer down, in
the shared cross-chain adapter, covering every channel at once — which is the
argument for retiring this slot rather than completing it, as a second copy of
the same check could drift out of agreement with the first. That decision is
tracked separately; the slot stays where it is either way, because moving it
would disturb the storage layout.
