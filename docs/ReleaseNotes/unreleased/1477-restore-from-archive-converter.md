## Thread — committed restore converter for the nightly archive (PR #TBD)

The off-chain restore runbook's two hardest steps — turning a decrypted
archive into D1 import batches, and materializing the legal-vault
objects for re-upload — previously had no committed tooling: inline
code in the runbook failed review twice during #1450 (fragments that
presented as runnable and were not), so the document honestly said
"write the transform at restore time". That gap is now closed by a
single tested script in the archive Worker's package.

The converter enforces every requirement the #1450 review accumulated:
imports are replace-not-merge (each batch leads with a delete so
selective restores cannot collide or leave attacker-inserted rows),
tables apply parents-before-children so foreign-key cascades cannot
erase a just-restored child, values and identifiers from the archive
are treated as untrusted (strict quoting, hard failure on anything
unrecognised), legal-vault keys are validated against the canonical
shape with filesystem-traversal rejection before any write, every
object is SHA-256-verified against the archive's own digest, and
uploads go through wrangler with argument arrays rather than shell
strings. A test suite pins each hostile-input rejection, and a new CI
job (mirroring the mesh-watcher pattern for standalone ops packages)
runs it on every change to the package. The restore runbook's §4 and
§5 now invoke the committed script instead of describing a hand-written
one. Closes #1477.
