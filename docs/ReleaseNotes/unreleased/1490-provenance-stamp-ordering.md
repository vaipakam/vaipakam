## Thread — the provenance stamp that always said "dirty" (PR #1490)

Several build and deploy scripts record which source state their output came from: a commit hash, plus a marker when the working tree had uncommitted changes at the time. The marker exists to separate two cases that matter to anyone auditing a build — an artifact generated from a committed state, which can be regenerated and compared, and one generated from a developer's half-finished tree, which cannot.

**The marker was set on every single run, so it separated nothing.** Each script tested the working tree *after* it had already written its own output, and that output is itself a working-tree change. The check could only ever come back dirty. Worse than useless: it read as a warning, so a genuinely dirty build looked exactly like a clean one, and the flag would have been ignored precisely when it mattered.

This was first noticed while trying to get a clean stamp on an unrelated change. Committing the source first and re-exporting afterwards still produced "dirty" — because the export's own files are what dirtied the tree. There was no operator discipline that could have produced a clean stamp; the check was unwinnable by construction.

**Seven scripts had it, not the one it was reported against.** The report named the frontend ABI export. The same few lines had been copied into the keeper-bot ABI export, the deployments export, the subgraph export, and all three deploy scripts. Each now takes the reading once, before it writes anything — which is also the reading that answers the actual question, "what state was this generated *from*".

**Two of them were failing in the opposite direction as well.** Where most scripts compared against the last commit, a few compared against the staging area instead — so a change that had been staged but not committed was reported as *clean*. That is the more dangerous error of the two, because it hides real drift rather than crying wolf about none. All seven now use the same comparison and count staged work as uncommitted, which it is.

**A check was added so an eighth copy cannot quietly reintroduce it.** The pre-deploy gate now looks at every script that writes one of these stamps and fails if the reading is taken after the script's first write, or if it is taken more than once. It finds those scripts by the shape of what they emit rather than by a hand-maintained list, which is how the two deploy scripts turned up — they were not in the original report and were not in the first sweep either. The check states its own blind spot in a comment: it recognises the four ways these scripts currently write files, and a script that writes some other way is only partly covered.

The fix was verified by watching the stamp change: clean from a committed tree, dirty from a tree with a real edit, and dirty from a tree whose only change was staged. The guard was verified the same way — by reintroducing the bug two different ways and confirming it went red for the right reason each time, then confirming it goes green again once restored.

No output artifact changes as a result of this; only the provenance line that describes it. Anything already recorded as "dirty" should be treated as unknown rather than as a genuine warning, since until now the flag could not have meant anything else.
