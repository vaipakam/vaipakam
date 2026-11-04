## Thread — Backups the archive Worker cannot read (PR #3152)

Slice 2 of the backup security design. The nightly archive Worker now
encrypts each archive to offline public keys: a fresh data key per archive,
wrapped to each of two committed recipient keys (a primary and an escrow, held
apart), so nothing the Worker holds can decrypt what it wrote. The recipient
public keys are a reviewed, append-only file in the repository, bundled at
build time; the private keys never reach Cloudflare, GitHub or any server.
Each archive carries an authenticated header naming its tier, period, creation
time and recipients, and each tier is encrypted on its own, so the January
monthly and the yearly are no longer the same bytes.

In the same change the Worker lost its reader. The weekly healthcheck, the
B2 read key it used and the symmetric decryption key are gone, so the Worker
holds one write-only key and cannot list, read or find an existing archive.
Its nightly report names each archive's tier, period, size and SHA-256, and no
longer the object's name, whose random part is what keeps a leaked write key
from overwriting it. Archives written before this change keep the exposure of
names already posted.

The backup watcher, which already ran outside Cloudflare, learned the header
check: an archive in the new format must be well formed, name its own tier
and period and a creation time within the run that uploaded it, and name
exactly the recipient set in force then; a manifest must declare the format
its archive is actually in; and once the first new-format archive is
recorded, an old-format one uploaded later pages. Nobody online holds a
private key, so a passing header is not proof that an archive decrypts; only
the offline restore drill shows that.

A new offline tool decrypts an archive for a restore, in either format, only
when the ledger vouches for it: it refuses tampered ledger entries, an archive
whose bytes are not the recorded ones, and a period with more than one entry,
until the operator names the one to trust, and it checks the decrypted
creation time against the header and the period. The restore runbook's
decrypt step and its key-rotation section were rewritten, because the old
rotation re-encrypted every archive and destroyed the old key, which every
pre-change archive still needs.

After deploy the owner deletes the three retired secrets and the monthly
baseline var from the Worker, keeps the old AES key offline indefinitely,
deletes old ops-channel messages that name archive keys, and runs a restore
drill. Closes #1463.

> Caveat: the rest of the restore runbook and the resilience design's §3.3–§3.6 still describe the deployment before this change; they are the design's docs slice.
