## Connected app — the last of the four React hook rules becomes enforced (PR #TBD)

The connected app's lint configuration keeps React's hook rules visible as
advisories and promotes each one to a hard error only once the existing code
is clean against it, so the standard is raised deliberately rather than
declared and then ignored. This is the fourth and final group: the rule that
objects when a component sets its own state directly inside an effect,
because doing so makes React render a second time to take the change.

This group is unlike the three before it. In each of those, the rule was
pointing at real defects — a frozen clock read during render, a ref written
where state belonged, effects reading values they did not declare — and the
work was to fix them. Here, having gone through all nine reports one at a
time, none of them is a defect. Every one is an effect doing the job effects
are for, reacting to something outside the component that changed:

- Three close a review the page had open — an instant-exit quote, an
  obligation transfer, a rate-ladder fill — because a background refresh
  showed the thing under review had moved or gone. Leaving a confirmed
  review standing against figures that have since changed is the hazard;
  closing it is the fix, and it cannot be decided while rendering because
  the news arrives afterwards.
- Two reload local state when the connected wallet or network changes: the
  notification bell's read-position, and the tariff card's ceiling field.
- One seeds an editable field from the first price quote that arrives, and
  then leaves it alone, because the moment the user types in it the value is
  theirs and a later quote must not overwrite it.
- One records that notifications have been seen, which is a write to
  browser storage first and a state update second.
- One resolves a shared link into a selected offer.

Each now carries a note saying which of those it is, so the next reader can
tell a considered exception from an oversight without re-deriving the
argument. No behaviour changed anywhere: these are explanations, not edits.

The ninth is different and is marked as such. The rental flow clears a
ticked acknowledgement when a security warning about the asset changes, and
that clear is deliberately the *second* line of defence — the first is a
check performed at signing time, which is what actually prevents signing
against a warning the user has not read. Whether the clear should instead
happen while rendering, as the offset flow now does, is an open question
tracked separately; if it is answered that way, this effect disappears and
its note goes with it. It is the only one of the nine that should ever come
back.

With the group at zero the rule is now enforced, which is what makes the
distinction stick: a new violation has to be argued for in the diff rather
than added to a list nobody reads. That closes the inventory #1520 was
opened against — the four rules that were actually being violated.

It does not mean every hook rule is now enforced. Eleven more remain
advisory, and all eleven are at zero, so by the same principle each could be
promoted. They are left as they are on purpose: those eleven have never
found anything here, so promoting them would be asserting a standard this
codebase has not yet been tested against, which is the opposite of how the
other four were earned.

No user-visible behaviour changes.
