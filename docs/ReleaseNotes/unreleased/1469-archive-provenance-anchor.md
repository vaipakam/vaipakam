### The nightly backup notification now records the archive's full fingerprint

The backup pipeline writes an encrypted archive each night and posts a short
summary to the operator channel: which files it wrote, how big, how many rows,
and a shortened fingerprint of the archive. That fingerprint is now recorded
in full.

It reads like a cosmetic change and is not. The restore path's existing checks
establish that an archive is **intact** and was encrypted with our key. They
cannot establish **who wrote it** — and the two are different questions with
the same-looking answer. Anyone able to edit the backup service holds both the
credential that writes to the storage provider and the key that encrypts, so
they can produce an archive of their own choosing that is correctly
fingerprinted and genuinely decrypts. Every verification in the restore
procedure then passes, and the procedure's rule of taking the newest archive
selects it.

The operator channel is the one record in that chain the same credentials
cannot rewrite. New messages can be posted, but a message sent on a given
night stays as it was — so comparing a candidate archive against what was
recorded at the time is a check the storage side cannot forge. That is the
only such check available today.

Binding a candidate to that record needs the whole fingerprint. Shortened, it
pinned a small fraction of it, and the party being defended against chooses
the contents being fingerprinted — so they can search for something that
matches a short prefix. At full length that search stops being worth
attempting.

This does not make a forged archive impossible; it makes one detectable by an
operator who checks. Preventing it outright is a storage-configuration
question — immutability settings on the bucket — recorded separately, along
with the finding that the current settings delete a replaced file after about
a day, so a genuine archive that gets overwritten is not available to fall
back on for long.

Part of #1469.
