## Local testing — the canonical specification's folder check

The new canonical specification folder, `docs/CanonicalSpec`, now has a check that reads every block in it. It refuses anything the folder's rules forbid. The rules are in CanonicalSpecDesign §3 and §4, and the block grammar is in the README of `packages/canonical-spec`. A statement may not carry a figure, a date, an issue reference, a word of history or anything shaped like code. Each statement needs the parts its kind requires, exactly one record entry, and an approval that matches its current text. Each mistake needs exactly one answering statement. Each lifecycle model must refuse every step out of state, must not hold two rows the check cannot tell apart, and must reach every state from its start.

The check fails closed. If it cannot read a line under a statement or a model, it reports the file and the line instead of skipping the block, so a statement can never silently owe no tests. It runs in two modes. Draft mode is for a domain under review: a new record entry may name what raised it. Folder mode is for the committed folder and needs the owner's approval hash on every entry. The check also prints the approval hashes for the record, and a neighbours report of the statements on each model step.

The wording list holds only salted hashes, so the refused words never appear in the public tree. CI runs the check's own tests, and runs the check over the folder whenever the folder exists.

Closes #3948
