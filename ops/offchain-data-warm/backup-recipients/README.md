# Backup recipients

The public keys every nightly archive is encrypted to (#1463; design:
[`BackupSecurityDesign.md`](../../../docs/DesignsAndPlans/BackupSecurityDesign.md)
§3.3). Nothing here is secret. The matching private keys are
passphrase-protected files in the operator's offline store and never reach
Cloudflare, GitHub or any server.

`recipients.json` lists **every set the Worker has ever used**, each with the
time it took effect:

- `set` — its position, from 1, in the order sets were appended.
- `effectiveFrom` — ISO-8601 UTC with milliseconds. The nightly uses the
  newest set whose `effectiveFrom` is not later than the run's start; the
  backup watcher judges each archive against the set in force when it was
  written.
- `recipients` — each a `name`, the `spki` (the public key's SPKI DER in
  base64, which is a PEM body without its line breaks) and its `fingerprint`,
  the SHA-256 of that DER in hex. Every key is RSA-4096 with exponent 65537.
  The Worker, the watcher and the tests each check that the fingerprint is
  the key's, so a hand edit cannot pair one key's fingerprint with another
  key.

**Append-only.** A rotation appends a set; it never edits or removes one, or
the watcher would judge older archives against the wrong keys. Two
recipients, held apart, is the minimum: losing every private key loses every
archive. The rotation procedure is in
[`OffChainRestore.md`](../../../docs/ops/OffChainRestore.md) §8.

The fingerprint of a public key, to compare with the file:

```bash
openssl pkey -pubin -in backup-primary.pub.pem -outform DER | sha256sum
```

| Set | In effect from | Recipients |
| --- | --- | --- |
| 1 | 2026-11-04 | `primary` (`bd8d92cc…0483d8`), `escrow` (`b963813e…318baa`) |
