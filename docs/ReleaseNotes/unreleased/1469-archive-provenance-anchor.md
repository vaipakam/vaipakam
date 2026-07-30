### Nightly backup notification records the full archive fingerprint

The nightly off-chain backup posts an ops summary to the operator Telegram
channel. It used to include only the first 16 characters of the archive's
fingerprint; it now records the whole thing, and the extra characters cost
nothing.

A short prefix is not useless — anyone can fingerprint a candidate archive
and compare the first 16 characters, and two unrelated files sharing them by
chance is vanishingly unlikely. What a short prefix cannot do is stand up to
someone deliberately trying to match it. Recording all of it removes a
bound rather than fixing a broken comparison.

**A correction, recorded because the mistake is an easy one to repeat.**
This change was originally justified as closing a real gap: that the
backup's own manifest can prove an archive is intact and encrypted under
our key, but cannot prove *who wrote it* — so someone who had taken over
the backup system could upload a replacement archive with a perfectly
consistent manifest, and every check the recovery procedure makes would
pass. That gap is real. The claim that this notification closed it was
wrong, in three separate ways:

- The credentials that let someone forge the archive also let them post to
  the operator channel. They come from the same place. A record cannot
  vouch for whoever wrote it.
- The channel is not a permanent record. A bot can edit and delete its own
  messages, so the original entry is not fixed once posted.
- Nothing reads it. The recovery procedure checks the archive against its
  own manifest and never against what was announced at the time.

The full fingerprint is still worth recording — an operator comparing two
candidate archives by hand needs all of it — but as an aid, not a
safeguard. The real gap is now tracked separately, along with what closing
it actually requires: a record the backup system itself cannot write to,
and a recovery step that consults it.

**Also fixed:** a nightly run whose ops notification failed to send used to
report success and move on, leaving a backup that exists with no record of
it anywhere an operator looks. The upload has already happened by then, so
this cannot fail the run — but it is now written to the Worker log, which
is the only channel left when the alert channel is the thing that broke.
