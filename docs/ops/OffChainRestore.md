# Off-chain data restore runbook

When you read this, something has gone wrong with the Cloudflare side
of Vaipakam — the account is locked out, the data is tampered with,
or a deploy mistake wiped a D1 table. This runbook walks the recovery
path back to a known-good off-chain state from a Backblaze B2 archive
produced by [`ops/offchain-data-archive`](../../ops/offchain-data-archive/README.md).

> **On-chain state is fine.** The Diamond, the VPFI token, and every
> position-NFT live on chain. The protocol's economic core is
> unaffected by anything in this document — what we're restoring is
> the off-chain convenience layer.

---

## 0. Prerequisites

- **The offline AES-256 encryption key** — 64 hex characters,
  generated at setup time and stored OUT of Cloudflare. If this is
  lost, the archives cannot be decrypted; the indexer-tables half of
  the restore can still run via the re-bootstrap path (step 4) but
  the legal-hold register + R2 legal-vault are unrecoverable.
- **The Backblaze B2 read credentials** — these are a SEPARATE pair
  of keys from the write-only key the Worker uses. The read keys
  live in the operator's offline secret store too. NEVER put read
  keys in any Cloudflare Worker — that re-introduces the SPOF.
- A workstation with `wrangler ≥ 4`, `node ≥ 22`, and `openssl`.
- Network access to GitHub (for the monorepo) + B2 + the target
  chain RPCs.

---

## 1. Stand up a fresh Cloudflare account

The order below matters: D1 databases get the new account's
`database_id` values, and every Worker's `wrangler.jsonc` binds to
those IDs. Deploying a Worker before its D1 exists (or with the old
account's ID still pinned in `wrangler.jsonc`) errors out at the
binding step. So: create the stores first, update the configs,
then deploy.

1. Sign up for a new Cloudflare account on a clean email + 2FA.
2. Clone the monorepo:

   ```bash
   git clone https://github.com/vaipakam/vaipakam.git
   cd vaipakam
   pnpm install
   ```

3. Create the D1 databases. Capture the printed `database_id` values
   — you'll paste these into the wrangler configs in step 5.

   ```bash
   wrangler d1 create vaipakam-archive
   wrangler d1 create vaipakam-lz-alerts-db
   ```

4. Create the R2 buckets:

   ```bash
   wrangler r2 bucket create vaipakam-legal-vault
   ```

5. Update every `wrangler.jsonc` in the monorepo that carries a
   `database_id` to the new IDs from step 3. The bound paths:

   - `apps/indexer/wrangler.jsonc`     → vaipakam-archive
   - `apps/keeper/wrangler.jsonc`      → vaipakam-archive
   - `apps/agent/wrangler.jsonc`       → vaipakam-archive
   - `ops/lz-watcher/wrangler.jsonc`   → vaipakam-lz-alerts-db
   - `ops/offchain-data-archive/wrangler.jsonc` → vaipakam-archive + vaipakam-lz-alerts-db

6. Apply migrations:

   ```bash
   ( cd apps/indexer    && wrangler d1 migrations apply vaipakam-archive --remote )
   ( cd ops/lz-watcher  && wrangler d1 migrations apply vaipakam-lz-alerts-db --remote )
   ```

7. NOW deploy the Workers — the bindings resolve cleanly because the
   D1 + R2 + updated configs all exist first.

   The `apps/*` Workers are in the pnpm workspace, so the root
   `pnpm install` from step 2 already populated their node_modules.

   The `ops/*` Workers are intentionally OUTSIDE the pnpm workspace
   (see `pnpm-workspace.yaml`) and carry their own `package-lock.json`
   files. On a fresh restore workstation their node_modules don't
   exist yet — `wrangler deploy` would fail at the dependency lookup.
   Run `npm ci` per ops/ Worker before deploying:

   ```bash
   pnpm --filter @vaipakam/indexer deploy
   pnpm --filter @vaipakam/keeper deploy
   pnpm --filter @vaipakam/agent deploy
   pnpm --filter @vaipakam/defi deploy
   pnpm --filter @vaipakam/www deploy
   ( cd ops/lz-watcher            && npm ci && npm run deploy )
   ( cd ops/offchain-data-archive && npm ci && npm run deploy )
   ```

> **Stop here and reassess if this is the right move.** Standing up a
> new CF account is appropriate for total loss; for live tampering or
> a single-table corruption you usually want to **selectively
> restore** into the existing account rather than rebuild from
> scratch. Skip to §5 in that case.

---

## 2. Download the most recent archive from B2

Archive + manifest object keys carry a 32-hex-char nonce per upload
(the immutable-naming guard against in-place overwrite). The layout
is:

```
archives/<YYYY-MM-DD>/<32-hex-nonce>.bin
manifests/<YYYY-MM-DD>/<32-hex-nonce>.json
```

Same nonce per archive/manifest pair, so once you have one path you
derive the other deterministically.

```bash
# 2.1 Authenticate the B2 CLI with the offline read credentials.
b2 account authorize <APPLICATION_KEY_ID> <APPLICATION_KEY>

# 2.2 Find the most recent manifest. The B2 CLI's `ls` does not
#     recurse into nested prefixes by default — pass --recursive
#     (post-2025 syntax) so the nonce-bearing files at
#     `manifests/<date>/<nonce>.json` actually surface. Sort by
#     LastModified (newest last) and take the tail.
b2 ls vaipakam-offchain-data-archive --recursive --long manifests/ \
  | sort -k 2,3 \
  | tail -5

# 2.3 Download the matching manifest + archive. Pick the manifest
#     key from the `ls` output above (last column of the line) and
#     plug it into MANIFEST_KEY. The archive key is the same path
#     with `manifests/` → `archives/` and `.json` → `.bin`.
MANIFEST_KEY=manifests/2026-05-24/abcdef0123456789abcdef0123456789.json
ARCHIVE_KEY="${MANIFEST_KEY/manifests\//archives/}"
ARCHIVE_KEY="${ARCHIVE_KEY/.json/.bin}"

mkdir -p restore
b2 file download \
  "b2://vaipakam-offchain-data-archive/${MANIFEST_KEY}" \
  ./restore/manifest.json
b2 file download \
  "b2://vaipakam-offchain-data-archive/${ARCHIVE_KEY}" \
  ./restore/archive.bin
```

The manifest is unencrypted JSON — open it and confirm:

- `archive.sha256` matches `sha256sum ./restore/archive.bin`.
- `archive.byteLength` matches `wc -c ./restore/archive.bin`.
- `d1.archive[]` row counts look sane (no zero counts on tables that
  should have data — `diag_errors`, `diag_legal_holds`, etc.).

If any of these mismatch, **stop**: the manifest is suspect (likely
an attacker upload via a leaked write key, or bit-rot). Pick the
next-newest manifest from the `ls` output and repeat. If two
consecutive manifests mismatch, the backup pipeline was broken
silently and the operator needs to investigate `wrangler tail
vaipakam-offchain-data-archive`.

---

## 3. Decrypt the archive

```bash
cat > restore/decrypt.mjs <<'EOF'
// Decrypts the archive locally — never run this with the AES key
// pasted on the command-line (history-disclosure risk). Read the key
// from the offline store into a transient env var instead.
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const [_node, _script, inPath, outPath] = process.argv;
const keyHex = process.env.BACKUP_ENCRYPTION_KEY;
if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex))
  throw new Error('Set BACKUP_ENCRYPTION_KEY env (64-hex-char AES-256 key) before running');

const keyBytes = new Uint8Array(32);
for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.slice(i*2, i*2+2), 16);
const key = await crypto.subtle.importKey(
  'raw', keyBytes, 'AES-GCM', false, ['decrypt'],
);

const buf = new Uint8Array(readFileSync(inPath));
const iv = buf.subarray(0, 12);
const ct = buf.subarray(12);
const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
writeFileSync(outPath, new Uint8Array(pt));
console.log(`decrypted ${pt.byteLength} bytes → ${outPath}`);
EOF

# Load the key from your offline store and run the decrypt:
read -rs -p "Paste BACKUP_ENCRYPTION_KEY: " BACKUP_ENCRYPTION_KEY
export BACKUP_ENCRYPTION_KEY
node restore/decrypt.mjs ./restore/archive.bin ./restore/archive.json
unset BACKUP_ENCRYPTION_KEY
```

If decryption throws, the archive is either tampered with or you
have the wrong AES key. Both cases stop the restore.

---

## 4. Restore the born-off-chain tables

The decrypted JSON has the shape produced by `backup.ts`:

```json
{
  "version": 1,
  "createdAt": "2026-05-23T03:17:00Z",
  "d1": {
    "archive":  [ { "name": "diag_errors", "schema": [...], "rowCount": N, "rows": [...] }, ... ],
    "lzAlerts": [ { "name": "lz_alert_state", "schema": [...], "rowCount": N, "rows": [...] }, ... ]
  },
  "r2": { "bucket": "vaipakam-legal-vault", "objects": [ { "key": "...", "size": N, "sha256": "...", "base64Body": "..." }, ... ] }
}
```

**Critical**: the two D1 databases are SEPARATE — restoring lz-watcher
tables into `vaipakam-archive` (or vice versa) lands data in the
wrong DB and will leave the originating database empty after the
restore. The `d1.archive[]` entries go to `vaipakam-archive`; the
`d1.lzAlerts[]` entries go to `vaipakam-lz-alerts-db`. Match by
source.

For each table:

1. Confirm the archive's `schema[]` matches the live DB's current
   shape. If a migration in main since the archive added or removed
   a column, you'll need a transformation pass. The schema-hash in
   the manifest lets you spot drift without diffing column-by-column.

2. Convert the `rows[]` array to a SQL `INSERT` batch. A small Node
   script does this cleanly:

   ```js
   const out = [];
   for (const r of table.rows) {
     const cols = Object.keys(r);
     const vals = cols.map((c) => quote(r[c])).join(', ');
     out.push(`INSERT INTO ${table.name} (${cols.join(', ')}) VALUES (${vals});`);
   }
   ```

3. Apply via wrangler — targeting the matching D1 binding:

   **`vaipakam-archive` tables** (born-off-chain): `diag_errors`,
   `diag_legal_holds`, `diag_legal_hold_audit`, `user_thresholds`,
   `notify_state`, `telegram_links`.

   ```bash
   wrangler d1 execute vaipakam-archive --file=restore/<table>.sql --remote
   ```

   **`vaipakam-lz-alerts-db` tables** (lz-watcher): `lz_alert_state`,
   `scan_cursor`, `oft_balance_history`.

   ```bash
   wrangler d1 execute vaipakam-lz-alerts-db --file=restore/<table>.sql --remote
   ```

4. Verify row counts match the manifest before moving to the next
   table.

---

## 5. Restore the R2 legal-vault

For each object in the decrypted `r2.objects[]`:

```js
const bytes = Buffer.from(obj.base64Body, 'base64');
// Use mkdir -p semantics — legal-vault object keys can contain
// `/` separators (e.g. `legal-holds/2026-05/notice-42.pdf`).
fs.mkdirSync(path.dirname(`restore/r2/${obj.key}`), { recursive: true });
fs.writeFileSync(`restore/r2/${obj.key}`, bytes);
// confirm SHA matches
```

Then upload. Two pitfalls to avoid:

1. **Don't iterate via `find . -type f`** — that emits paths like
   `./legal-holds/notice-42.pdf` whose leading `./` would become
   part of the R2 object key. The restored D1's `legal_doc_ref`
   rows reference the ORIGINAL keys (`legal-holds/notice-42.pdf`),
   so a `./`-prefixed key would silently break every legal-document
   lookup. Iterate by archived `obj.key` instead.
2. **Don't interpolate `obj.key` into shell strings** — a key that
   contains a single quote / dollar sign / backtick would break the
   shell command (or worse, execute attacker-controlled fragments
   when restoring an archive whose write key has leaked). Use
   `child_process.spawnSync` with an argv ARRAY so wrangler receives
   each argument verbatim, no shell parsing.

```bash
# scripts/restore-r2.mjs — preserves the archived key verbatim,
# no shell parsing of object names.
node - "$PWD/restore/archive.json" <<'NODE'
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const archivePath = process.argv[2];
if (!archivePath) {
  console.error('Usage: node restore-r2.mjs <decrypted-archive.json>');
  process.exit(2);
}
const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
for (const obj of archive.r2.objects) {
  const local = `restore/r2/${obj.key}`;
  const target = `vaipakam-legal-vault/${obj.key}`;
  // spawnSync with argv-array, NOT shell-string. Each arg is passed
  // verbatim to wrangler — no shell parsing means no escape rules
  // to get wrong, no injection risk if obj.key contains '$' / '`' /
  // single-quote / etc.
  const r = spawnSync(
    'wrangler',
    ['r2', 'object', 'put', target, '--file', local, '--remote'],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    throw new Error(`wrangler r2 object put failed for ${obj.key}`);
  }
}
NODE
```

Per-object SHA-256 in the archive lets you verify each upload landed
intact (compare against `wrangler r2 object get … --pipe | sha256sum`).

---

## 6. Re-bootstrap the indexer

For the re-derivable tables (`offers`, `loans`, `activity_events`,
`oracle_snapshot_state`, `liquidity_confidence`, `indexer_cursor`),
the design doc favours **re-indexing from block 0** over restoring
from the archive. Why:

- Re-indexing produces the canonically-correct state from chain logs.
  The archive could be days old — re-indexing catches up to head.
- The archive could itself be subtly wrong (silent corruption,
  pre-image of a tampered DB). Re-indexing is the integrity-checking
  restore path.

```bash
# Reset the indexer cursor so it starts from genesis.
wrangler d1 execute vaipakam-archive \
  --command="DELETE FROM indexer_cursor" --remote

# Trigger the indexer cron to start filling. Watch the catch-up:
wrangler tail vaipakam-indexer
```

Expect a multi-hour catch-up depending on chain history depth.
During catch-up the frontend renders the offer-book from the in-
browser `lib/logIndex.ts` fallback path — degraded UX, no data loss.

When the indexer cursor reaches `latest - 100` blocks, the
`/offers/stats` endpoint's `indexer.lastBlock` reads current, and
the frontend silently switches back to the cached fast path.

---

## 7. Smoke test before re-pointing production

1. Run `pnpm --filter @vaipakam/indexer check-event-coverage` to
   confirm the indexer's event-handling surface hasn't drifted.
2. On a testnet chain, create an offer, accept it, repay it. Confirm
   the full lifecycle lands in the restored D1 + the frontend
   renders each step.
3. Confirm the legal-hold register's audit trail is intact — pick a
   random hold from the archive's `diag_legal_hold_audit` and
   confirm the chain of `action_type` + `created_at` entries is
   present and ordered.
4. Run the weekly healthcheck manually on the freshly-recreated
   `vaipakam-offchain-data-archive`:

   ```bash
   wrangler tail vaipakam-offchain-data-archive
   # Trigger the cron manually from the CF dashboard's "Trigger" button.
   ```

   The first run should produce a fresh archive + green Telegram
   alert.

5. Update DNS / frontend env vars to point at the new Worker
   subdomains. Take a final on-chain snapshot of total offers /
   loans counts before the cut-over so any post-restore drift is
   detectable.

---

## 8. Key-rotation procedure for `BACKUP_ENCRYPTION_KEY`

Not part of an emergency restore, but documented here because the
two procedures share the offline-key handling discipline.

1. Generate a NEW key locally:

   ```bash
   openssl rand -hex 32 > /tmp/new-backup-key
   ```

2. Download the past 30 nightlies from B2 to a local workstation.
3. For each archive: decrypt with the OLD key, re-encrypt with the
   NEW key, re-upload to B2 under the same object key (B2's
   versioning preserves the prior cipher-text version for the
   lifecycle retention window).
4. `wrangler secret put BACKUP_ENCRYPTION_KEY` on
   `vaipakam-offchain-data-archive` to flip the Worker to the new key.
5. Wait for one full nightly cycle + one weekly healthcheck. Both
   should land green on the new key.
6. Retire the OLD key — destroy the offline copies. Keep ONE
   archived offline copy in case of a B2 lifecycle anomaly that
   surfaces an old-cipher version mid-cycle.

The rotation window has TWO keys live at once. Treat that window as
a security-sensitive interval; don't merge anything to main during
it.
