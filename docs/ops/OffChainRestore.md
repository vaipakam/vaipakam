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
- **The Backblaze B2 restore credentials** — a SEPARATE pair from the
  keys the archive Worker holds, kept in the operator's offline secret
  store. These are the ones that must never go into a Worker: they are
  the broad credentials the restore path uses, and putting them in
  Cloudflare re-introduces the single point of failure.

  This is NOT a prohibition on the scoped `B2_READ_*` pair the archive
  Worker binds. The weekly healthcheck has to perform signed GETs to
  verify archives, and the Worker's `assertRequiredEnv()` aborts EVERY
  scheduled run — nightly backups included — if the pair is unset. So it
  is required in the Worker by design. Read the rule as "the restore keys
  stay offline", not "no B2 read key may exist in a Worker" — the two were
  previously conflated, which made the prerequisite and the secret list
  below mutually exclusive.

  > **What that key does and does not protect, stated accurately.** An
  > earlier revision justified it as reading "only encrypted ciphertext",
  > implying the offline AES key still gates plaintext. That is true of a
  > **B2-side** compromise and false of a **Cloudflare-side** one: the same
  > Worker binds the raw `BACKUP_ENCRYPTION_KEY` (`env.ts`
  > declares it, `assertRequiredEnv()` requires it, and `index.ts` imports
  > it at boot via `importBackupKey`), and this runbook uploads it into the
  > same store alongside `B2_READ_*`. So an attacker with **Workers Edit**
  > on the account can deploy code that exfiltrates both, fetch every
  > archive, and decrypt the born-off-chain tables and the legal vault.
  >
  > The real boundaries are therefore: the offline AES key defends against
  > B2 compromise, loss of the B2 credentials alone, and anyone reading the
  > bucket without Cloudflare access. It does **not** defend against a
  > Cloudflare account compromise, which is the same blast radius as the
  > live data. Treat Workers Edit as equivalent to plaintext archive
  > access, and account-level controls (2FA, member audit, token scoping)
  > as the control that actually bounds it.
  >
  > Separating the two — so the decryption key never co-resides with the
  > read credentials — is a design change rather than a runbook edit, and
  > is tracked as #1463.
- **Offline copies of every Worker secret.** The B2 archive backs up D1
  rows and R2 objects ONLY. Nothing in it restores the
  `vaipakam-credentials` Secrets Store or the per-Worker secrets — the
  per-chain RPC URLs (which carry API keys), `KEEPER_PRIVATE_KEY`,
  `PUSH_CHANNEL_PK`, `TG_BOT_TOKEN`, `DIAG_WALLET_HMAC_KEY`, the
  0x / 1inch / OpenSea keys, the Alchemy webhook signing keys, and the
  archive Worker's own nine. An operator holding only the AES key and the
  B2 read keys will get as far as the deploy step and stop. Treat this
  bullet as the reason the list above is not exhaustive.
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
   ```

   > **#1440** — `vaipakam-lz-alerts-db` is NOT recreated. It belonged to
   > `ops/lz-watcher`, a monitor for the LayerZero transport the T-068 CCIP
   > migration retired; the Worker, its binding **and its source tree** are
   > all gone. (Creating the database itself would cost no cron slot —
   > slots are consumed by deploying a Worker with a scheduled trigger,
   > never by a D1 database — so if you DO need the legacy rows, creating
   > an inert database for them is free and supported.) See "Restoring a
   > pre-#1440 archive" below if the archive you hold still carries its
   > tables.

4. Create the R2 buckets:

   ```bash
   wrangler r2 bucket create vaipakam-legal-vault
   ```

5. Update every `wrangler.jsonc` in the monorepo that carries a
   `database_id` to the new IDs from step 3. The bound paths:

   - `apps/indexer/wrangler.jsonc`     → vaipakam-archive
   - `apps/keeper/wrangler.jsonc`      → vaipakam-archive
   - `apps/agent/wrangler.jsonc`       → vaipakam-archive
   - `ops/offchain-data-archive/wrangler.jsonc` → vaipakam-archive

   > `ops/mesh-watcher` is deliberately NOT part of this runbook. It owns a
   > SEPARATE database (`vaipakam-mesh-alerts-db`) that this archive does not
   > back up, and the Worker is undeployed — so there is nothing here to
   > restore. Its own README carries the create / migrate / secrets / deploy
   > procedure; adding a half-step here would leave an operator holding a
   > database id this runbook never produced.

6. Recreate the CREDENTIALS. The archive does not contain any of them,
   and this must happen before the deploy: wrangler validates every
   `secrets_store_secrets` binding at deploy time, so `apps/{indexer,
   keeper,agent}` fail outright on a fresh account until the store exists
   and is populated.

   a. Create a replacement account-level Secrets Store and capture its id:

      ```bash
      wrangler secrets-store store create vaipakam-credentials --remote
      ```

   b. Substitute that new id for the OLD account's
      `1e66429d0fa24aa38a27bc05b7bcf63e` in every `wrangler.jsonc` that
      carries a `store_id` — `apps/indexer`, `apps/keeper`, `apps/agent`.
      Same class of work as step 5; do both in one pass rather than
      discovering this one after migrations.

   c. Populate every secret the three configs bind, from your offline
      copies. The binding lists in those files are the authoritative
      inventory; as of this writing they are the per-chain `RPC_*` URLs
      (mainnet + testnet), `KEEPER_PRIVATE_KEY`, `PUSH_CHANNEL_PK`,
      `TG_BOT_TOKEN`, `DIAG_WALLET_HMAC_KEY`, `ZEROEX_API_KEY`,
      `ONEINCH_API_KEY`, `OPENSEA_API_KEY` and the
      `ALCHEMY_WEBHOOK_SIGNING_KEY_*` set:

      Each `secret create` makes exactly ONE secret and takes a singular
      `--name`, so derive the full set from the configs and iterate — a
      hand-written subset leaves the rest absent and every Worker deploy
      then fails binding validation:

      ```bash
      STORE=<the new store id>

      # Every distinct store-bound secret name across all three Workers.
      NAMES=$(grep -ho '"secret_name": *"[A-Z_0-9]*"' \
                apps/keeper/wrangler.jsonc \
                apps/agent/wrangler.jsonc \
                apps/indexer/wrangler.jsonc \
              | grep -o '[A-Z_0-9]\{3,\}' | sort -u)
      echo "$NAMES"   # eyeball it before running the loop

      for NAME in $NAMES; do
        echo "--- $NAME"
        # No --value and no pipe: wrangler PROMPTS, so the value never enters
        # the command line and cannot be recovered from shell history.
        # Wrangler's own help calls --value "Only for testing. Not secure as
        # this will leave secret value in plain-text in terminal history".
        wrangler secrets-store secret create "$STORE" \
          --name "$NAME" --scopes workers --remote
      done
      ```

      This reconstructs the entire credential set — keeper key, bot token,
      Push key, RPC URLs with embedded API keys — so a history file left
      behind here re-creates the compromise the restore is recovering from.
      That is why the prompt matters and not just the loop.

      `--scopes workers` is REQUIRED. Use this positional-store-id form —
      it is the one verified against the live API
      (`docs/DesignsAndPlans/SecretsStoreMigration.md` §9).

   d. `ops/offchain-data-archive` does NOT use the Secrets Store; its nine
      secrets are per-Worker `wrangler secret put`. Those are **not**
      validated at deploy, so skipping them lets the Worker deploy green
      and then fail at 03:17 UTC — silently, which is the exact failure
      mode the nightly exists to prevent. Set them before step 8:

      The first seven are HARD-REQUIRED — `assertRequiredEnv()` in
      `ops/offchain-data-archive/src/index.ts` aborts every scheduled
      invocation if any is missing, so omitting one produces a Worker that
      deploys green and then never backs anything up. The two `TG_OPS_*`
      values are optional (their absence downgrades to a console warn):

      ```bash
      ( cd ops/offchain-data-archive
        for NAME in BACKUP_ENCRYPTION_KEY \
                    B2_ENDPOINT B2_BUCKET \
                    B2_WRITE_ACCESS_KEY_ID B2_WRITE_SECRET_ACCESS_KEY \
                    B2_READ_ACCESS_KEY_ID B2_READ_SECRET_ACCESS_KEY \
                    TG_OPS_BOT_TOKEN TG_OPS_CHAT_ID; do
          wrangler secret put "$NAME"
        done )
      ```

      Check that Worker's `wrangler.jsonc` for the current full list —
      it is the authoritative inventory, not this snippet.

   e. `apps/agent` ALSO carries per-Worker secrets that are not in the
      Secrets Store, and therefore in no binding list —
      `TG_OPS_BOT_TOKEN` and `TG_OPS_CHAT_ID` (`apps/agent/README.md`).
      Not deploy-validated either, and while unset the agent looks
      healthy: `notifyOpsNewTicket()` silently skips every instant
      support-ticket alert and tickets land in D1 unannounced.

      ```bash
      ( cd apps/agent
        wrangler secret put TG_OPS_BOT_TOKEN
        wrangler secret put TG_OPS_CHAT_ID )
      ```

      The general rule: a Worker's `secrets_store_secrets` array is the
      authoritative list of its STORE bindings, NOT of its secrets. Check
      each Worker's README for plain `wrangler secret put` values too.

   f. The keeper's **operational flags** are not secrets, are not in the
      archive, and are not committed — so a restore that follows only the
      steps above completes with the signing key present and every
      autonomous path dark, indefinitely and silently. They are plain
      `vars`, described in `apps/keeper/wrangler.jsonc` as
      operator-managed, and `apps/keeper/wrangler.jsonc`'s committed `vars`
      block carries only `TG_BOT_USERNAME`:

      | Flag | While unset | Arms |
      |---|---|---|
      | `KEEPER_ENABLED` | `isKeeperEnabled()` is false | autonomous liquidation, the matcher, liquidity-confidence submits, auto-lifecycle — and it gates the two flags below as well |
      | `REWARD_REMIT_ENABLED` | remit + remit-ACK passes skip | reward-budget remittance and delivered-backing acknowledgement |
      | `REWARD_COMMIT_ENABLED` | commitment-report pass skips | mirror→canonical commitment reporting |

      Capture their **values** in the same offline record as the
      credentials — they are operator state that nothing else preserves.
      Any optional tuning knobs actually in use (`REWARD_REMIT_LOOKBACK_DAYS`,
      `REWARD_REMIT_LANE_CAP`, `REWARD_COMMIT_LOOKBACK_DAYS`, the `LIQ_*` /
      `SPLIT_*` / `PARTIAL_LIQ_*` set) belong in that record too; unlike the
      three above, those have safe defaults, so an omission degrades tuning
      rather than turning a duty off.

      **Do NOT set them here.** They arm signing against a database §§4–6
      have not restored: a matcher or liquidator pass reading half-imported
      state would submit real transactions from a real key. Re-arming is
      §7a, after the smoke test, and is deliberately the last thing that
      happens before the backup writer.

7. Apply migrations:

   ```bash
   ( cd apps/indexer    && wrangler d1 migrations apply vaipakam-archive --remote )
   ```

8. Add the `vaipakam.com` ZONE to the replacement account BEFORE any
   Worker deploy.

   `apps/indexer/wrangler.jsonc` declares `indexer.vaipakam.com` as a
   deploy-time custom-domain route, so its deploy FAILS outright until the
   zone is present — this is not a post-deploy tidy-up.

   Every OTHER Worker is the opposite shape: it declares no route, so its
   hostname must be bound by hand in the dashboard after deploy. That
   includes both public surfaces — `apps/defi` and `apps/www` are
   **Workers Static Assets** deployments, NOT Pages projects, so nothing
   in their configs attaches a domain and deploying them leaves the sites
   reachable only on their `*.workers.dev` URLs. Bind, after deploying:

   - `agent.vaipakam.com` → `vaipakam-agent`
   - `defi.vaipakam.com` → `vaipakam-defi`
   - `vaipakam.com` (apex — the canonical, indexable hostname) →
     `vaipakam-www`, plus `labs.vaipakam.com` → `vaipakam-www` if the
     legacy hostname is still wanted
   - `www.vaipakam.com`: **not** a Worker binding, and it needs TWO
     things, both zone-level and neither travelling with any Worker
     config:
     1. a **proxied DNS record** for `www` (orange-clouded `CNAME
        www → vaipakam.com`). A Bulk Redirect rule only fires on traffic
        that reaches Cloudflare, and on a fresh account nothing resolves
        `www` until this exists — so without it `www` stays NXDOMAIN and
        the rule below never runs, while the apex works perfectly and
        hides the gap;
     2. the **Bulk Redirect rule** `www.vaipakam.com/* →
        https://vaipakam.com/$1` (301).

     Both are easy to miss precisely because the apex site comes back
     looking healthy without them.

9. Register the **rate-limit namespaces** before deploying `agent` or
   `indexer`. Cloudflare validates at deploy time that every `namespace_id`
   in a `ratelimit` binding is registered to the account, so on a
   replacement account both deploys stop at binding validation — the D1,
   R2 and Secrets Store work above does not cover this.

   **Derive the list from the configs rather than trusting one written
   here** — bindings get added, and a hand-copied list goes stale silently
   while presenting as complete:

   ```bash
   grep -h '"namespace_id"' apps/agent/wrangler.jsonc \
     apps/indexer/wrangler.jsonc | grep -o '"[0-9]\+"' | tr -d '"' | sort -u
   ```

   As of this writing that is TEN ids for `apps/agent` — `555`, `1001`,
   `1002`, `1004`, `1005`, `1006`, `1007`, `1008`, `1009`, `1010`, all
   unconditional — and `2001`, `2002` for `apps/indexer`. The ids are
   arbitrary per Worker, so either register those numbers on the new
   account or renumber the bindings to match its scheme — but do one of
   the two before deploying either Worker.

   Then deploy the Workers — bindings resolve cleanly because the D1 + R2 +
   rate-limit namespaces + updated configs all exist first.

   > **Deploy them with their SCHEDULES OFF.** All three of
   > `apps/{indexer,keeper,agent}` declare `"crons": ["* * * * *"]`, so a
   > plain `wrangler deploy` here arms every-minute scheduled work against a
   > database that §§4–6 have not restored or verified yet. Concretely: the
   > indexer starts writing before §6 resets its cursor; the keeper's alert
   > passes are NOT behind `KEEPER_ENABLED` (only the signing passes are), so
   > `runWatcher` / `runPreGraceWatcher` begin messaging users off
   > half-imported `user_thresholds` and `notify_state`; and the agent's
   > retention passes begin pruning `diag_errors` / `support_tickets` /
   > expired `telegram_links` while those tables are still being imported one
   > at a time — deleting restored rows before §4's manifest row-count check
   > can even see them.
   >
   > Same hazard the archive Worker gets its own warning for below, and the
   > same remedy: do not let a cron run before the data it reads is real.
   > For each of the three, set the trigger list empty for this deploy —
   >
   > ```jsonc
   > "triggers": { "crons": [] }
   > ```
   >
   > — then deploy. **Confirm it, do not assume it:** an empty list is what
   > unregisters the schedule, but a mistyped or wrongly-nested key silently
   > leaves the committed cron in place, so read the schedules back before
   > moving on. The readback has to be **trigger-aware** — check the
   > Worker's *Settings → Trigger Events* pane, or query the schedules
   > directly:
   >
   > ```bash
   > read -rsp 'Cloudflare API token: ' CF_API_TOKEN; echo
   > printf 'url = "https://api.cloudflare.com/client/v4/accounts/%s/workers/scripts/%s/schedules"\nheader = "Authorization: Bearer %s"\nsilent\n' \
   >   "$CF_ACCOUNT_ID" "<worker-name>" "$CF_API_TOKEN" | curl -K -
   > ```
   >
   > The token goes to curl on **stdin**, not in `-H`. A restore-scoped
   > Cloudflare token is a recovery credential with broad rights over the
   > replacement account; expanded into an argument it is readable from
   > `ps` / `/proc/<pid>/cmdline` by any other user on the workstation, for
   > the lifetime of the request. Same reasoning and same mechanism as the
   > Telegram rotation in `IncidentRunbook.md` §4. `unset CF_API_TOKEN`
   > when the restore is done.
   >
   > Do **not** use `wrangler deployments status` for this: it reports
   > deployment metadata and versions, not cron triggers, so it shows a
   > healthy latest deployment while an every-minute schedule is still
   > live — it cannot see the exact mistake this readback exists to catch.
   > Nothing in §§2–6 needs a cron to run.
   >
   > These are restored later, deliberately split in two: the indexer's at
   > the end of §6 (once its cursor is reset), and the keeper's and agent's
   > in §7a after the smoke test. Do not simply revert the config now — the
   > point is that the schedules stay off until each one's data is verified.

   > **DO NOT deploy `ops/offchain-data-archive` yet.** Deploy it LAST,
   > after §2 has selected the archive and the D1/R2 data is actually
   > restored. A fresh archive Worker reaching its 03:17 cron before then
   > writes a validly encrypted, correctly checksummed backup **of the new
   > account's empty databases** — and the `sort … | tail -5` selection
   > later in this runbook would present that object as the NEWEST
   > recovery candidate. An operator part-way through a restore could
   > mistake it for the pre-loss backup and restore nothing over nothing.
   > Its own step is at the end of this section.

   > **ORDER MATTERS for the frontend, and it is not obvious.** Vite
   > embeds `VITE_INDEXER_ORIGIN` and `VITE_AGENT_ORIGIN` at BUILD time,
   > and `apps/defi/.env.production` still carries the OLD account's
   > hosts. So a `defi` bundle built here calls hosts that no longer
   > answer, and editing the env afterwards changes nothing until it is
   > rebuilt. `apps/agent` additionally needs an operator-created
   > custom-domain binding — its Wrangler config declares no route.
   >
   > Deploy the WORKERS here, then choose the new origins and create the
   > agent's custom domain, then update `apps/defi/.env.production` and
   > **rebuild and redeploy `defi` and `www`** before the smoke test.
   > The smoke-test step assumes the frontend already points at the
   > restored Workers; it does not do the rebuild for you.

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
   ```

   THEN provision origins — this is a real pause, not a formality:

   - create `apps/agent`'s custom domain (its Wrangler config declares no
     route, so nothing binds it automatically);
   - note the new `indexer` and `agent` subdomains;
   - set `VITE_INDEXER_ORIGIN` / `VITE_AGENT_ORIGIN` in
     `apps/defi/.env.production`.

   ONLY THEN build and deploy the frontends. Vite embeds those origins at
   BUILD time, so a bundle produced before this point calls the lost
   account's hosts and editing the env afterwards changes nothing:

   ```bash
   pnpm --filter @vaipakam/defi deploy
   pnpm --filter @vaipakam/www deploy
   ```

   **The archive Worker is NOT deployed here.** Its step is at the END of
   this runbook, after §§4–5 have actually restored D1 and R2. Deploying it
   now means its 03:17 cron can fire while you are still working through
   those sections, writing a valid backup of the freshly-migrated but EMPTY
   account into the same B2 bucket — which the newest-manifest selection in
   §2 would then pick. See "Last: activate the backup writer" below.

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
    "archive":  [ { "name": "diag_errors", "schema": [...], "rowCount": N, "rows": [...] }, ... ]
  },
  "r2": { "bucket": "vaipakam-legal-vault", "objects": [ { "key": "...", "size": N, "sha256": "...", "base64Body": "..." }, ... ] }
}
```

### Restoring a pre-#1440 archive

`d1.lzAlerts` is **OPTIONAL within version 1**. Archives written before
2026-07-28 carry it; archives written after do not, because the binding to
`vaipakam-lz-alerts-db` was removed with the retired LayerZero monitor
(#1440). The format version stays `1` because nothing else about the shape
changed — a reader must treat the key as optional rather than select a
parser on the version marker.

If you are restoring an archive that HAS the section and you genuinely need
that data — alert de-duplication state and per-chain block cursors for a
transport that no longer exists, so almost certainly not — restore it to a
database you create by hand for the purpose. Do **not** recreate
`ops/lz-watcher` to hold it: deploying that package would resurrect a
retired Worker, and THAT is what would take one of the account's five
cron-trigger slots. Creating the database costs no slot — slots are consumed
by deploying a Worker with a scheduled trigger, never by a D1 database — so
do not let the warning stop you creating an inert one to inspect or restore
the rows. Otherwise ignore the section.

**Create the tables first.** The generated import below is `INSERT`
statements only, and #1440 deleted the watcher's migration along with the
package — so an empty database fails every insert with `no such table`,
and the general restore steps will not create them for you. Recover the
schema from git history and apply it by hand:

```bash
wrangler d1 create vaipakam-lz-alerts-db          # or any name you like
git show 24641f98:ops/lz-watcher/migrations/0001_init.sql > /tmp/lz.sql
wrangler d1 execute <that database> --file=/tmp/lz.sql --remote
```

`24641f98` is the last commit on `main` that still carried the file; any
commit before #1440 merged works. Only then run the row import.

**Critical**: `d1.archive[]` entries go to `vaipakam-archive`. Restoring
another database's tables into it lands data in the wrong place and leaves
the originating database empty after the restore. Match by source.

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
   `notify_state`, `telegram_links`, `support_tickets`.

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
```

**Only now re-arm the indexer's schedule** — the cursor reset above is
exactly the precondition §1 step 9 held it back for. Restore
`"triggers": { "crons": ["* * * * *"] }` in `apps/indexer/wrangler.jsonc`
and redeploy that Worker alone. Re-arming it before the reset would have
had it write from whatever cursor it found and then be reset out from
under itself mid-write.

The keeper's and agent's schedules stay off through this section; they are
§7a, after the smoke test.

```bash
# Watch the catch-up:
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

(The backup Worker is deliberately NOT smoke-tested here — it does not
exist yet. It is deployed and exercised in §7b, for the reason given
there.)

4. Update DNS / frontend env vars to point at the new Worker
   subdomains. Take a final on-chain snapshot of total offers /
   loans counts before the cut-over so any post-restore drift is
   detectable.

---

## 7a. Re-arm the keeper and agent — schedules first, then the flags

Everything up to here has run with `apps/keeper` and `apps/agent` deployed
but never scheduled (§1 step 9). This is where that ends. The order below is
the point of the section: it moves from passes that only read, to passes
that message users, to passes that sign transactions — so a mistake is
caught at the cheapest stage.

1. **Restore both schedules and redeploy.** Put
   `"triggers": { "crons": ["* * * * *"] }` back in
   `apps/keeper/wrangler.jsonc` and `apps/agent/wrangler.jsonc` and deploy
   each. The keeper's alert passes (`runWatcher`, `runPreGraceWatcher`,
   `runDailyOracleSnapshot`) and the agent's notification and retention
   passes start here — reading tables §§4–6 have now restored and §7 has
   smoke-tested. Expect the first tick within a minute.

2. **Watch one full tick on each before going further.**

   ```bash
   wrangler tail vaipakam-keeper   # in one shell
   wrangler tail vaipakam-agent    # in another
   ```

   A first tick that throws on a missing table or an empty binding means
   something in §§4–6 did not land; fix that before arming any signing
   path. Note the keeper's alert passes will send real user notifications
   from this moment — if the restore is long enough that thresholds have
   gone stale, expect a burst.

3. **Only then set the keeper's operational flags**, from the offline
   record captured in §1 step 6f. These arm signing from a real key, so
   they are deliberately last and deliberately separate from the deploy.

   **Set them by editing `apps/keeper/wrangler.jsonc`'s `vars` block — all
   of the ones that were on, together — and deploying once:**

   ```jsonc
   "vars": {
     "TG_BOT_USERNAME": "…",
     "KEEPER_ENABLED": "true",
     // only those that were on before the outage:
     "REWARD_REMIT_ENABLED": "true",
     "REWARD_COMMIT_ENABLED": "true"
   }
   ```

   ```bash
   ( cd apps/keeper && wrangler deploy )
   ```

   `REWARD_REMIT_ENABLED` additionally requires the keeper EOA to be
   authorized on-chain and D1 migration 0044 applied, neither of which a
   restore re-establishes — leave it off until both are true.

   > **Do NOT arm these with `--var`, one flag per deploy.** It fails two
   > separate ways, and the second is silent and immediate.
   >
   > `wrangler deploy --help` on the pinned version states it plainly:
   > *"When not used (or set to false), Wrangler will delete all vars before
   > setting those found in the Wrangler configuration."* So each deploy
   > rebuilds the var set from the config plus that invocation's `--var`
   > flags. `KEEPER_ENABLED` is not in the committed config, so a follow-up
   > `wrangler deploy --var REWARD_REMIT_ENABLED:true` **deletes it** — the
   > final deployment leaves `isKeeperEnabled()` false and every signing
   > duty off, with the last command having looked like it succeeded.
   >
   > Second, `--var` does not persist: it applies to that deployment only.
   > Even done correctly in one invocation, the next `wrangler deploy` from
   > a checkout whose `vars` still omit the flags disarms everything again —
   > the same invisible-off state this step exists to fix, now with a
   > completed-looking restore behind it.
   >
   > Committing the values avoids both, and leaves a reviewable record. If
   > you must arm temporarily without editing the config, pass **every**
   > flag in a **single** `wrangler deploy` and add `--keep-vars`.

4. **Read the deployed variable values back.** Do not infer the flags took
   from a quiet `wrangler tail`: `runRewardBudgetRemit`, `runRemitAck` and
   `runCommitmentReport` all `return` silently at their flag guards, and a
   correctly-armed pass is *also* silent when there is no pending work or
   the chain is inapplicable. Silence therefore means "off" and "armed with
   nothing to do" equally, and the restore can complete with remittance or
   commitment reporting still dark. A typo reads as false and is
   indistinguishable from deliberately-off — the same invisible failure the
   uncommitted flags caused in the first place.

   The authoritative check is the deployed settings, which list the
   variables actually in effect:

   ```bash
   read -rsp 'Cloudflare API token: ' CF_API_TOKEN; echo
   printf 'url = "https://api.cloudflare.com/client/v4/accounts/%s/workers/scripts/vaipakam-keeper/settings"\nheader = "Authorization: Bearer %s"\nsilent\n' \
     "$CF_ACCOUNT_ID" "$CF_API_TOKEN" | curl -K -
   unset CF_API_TOKEN
   ```

   Confirm each flag you intended is present and reads the value you meant.
   **The two guards do not parse alike**, which is a trap worth knowing
   before you eyeball the output:

   | | accepts | rejects |
   |---|---|---|
   | `KEEPER_ENABLED` (`isKeeperEnabled`) | `true` / `1`, **case-insensitive** — `True` and `TRUE` are on | anything else, **and** it returns false whenever `KEEPER_PRIVATE_KEY` is unset, regardless of the flag |
   | `REWARD_REMIT_ENABLED`, `REWARD_COMMIT_ENABLED` (`flagOn`) | exactly `true` or `1`, **case-SENSITIVE** | `True`, `TRUE`, and anything with surrounding whitespace |

   So `KEEPER_ENABLED=True` works while `REWARD_REMIT_ENABLED=True` is
   silently off. Use lowercase `true` for all three and the asymmetry
   never bites.

   Note the second half of the `KEEPER_ENABLED` row: the settings readback
   shows *variables*, and `isKeeperEnabled` also requires the
   `KEEPER_PRIVATE_KEY` **secret** to resolve. A green variable readback is
   necessary, not sufficient — confirm the store binding from §1 step 6
   too. The Worker's *Settings → Variables* pane shows the same variables.

   Only after that is a tail useful, and then only as positive
   confirmation: watch for a pass you expect to have work to do.

---

## 7b. LAST: activate the backup writer

Only now — after §§4–5 have restored D1 and R2, and §7's smoke test says
the stack is real — deploy `ops/offchain-data-archive`:

```bash
( cd ops/offchain-data-archive && npm ci && npm run deploy )
```

**Why it is last, and not with the other Workers.** Its cron fires at
03:17 UTC. Deployed at the start of a restore, it will happily write a
validly encrypted, correctly checksummed archive **of the freshly-migrated
empty account** into the same B2 bucket the restore reads from — and §2's
"pick the newest manifest" step would then select that object. An operator
part-way through a multi-hour restore could restore nothing over nothing
and see every checksum pass.

Nothing distinguishes that empty archive from a real one by inspection:
same encryption, same manifest shape, a later timestamp. The only defence
is not creating it, which is why this step sits here rather than beside
the deploys that logically resemble it.

Then exercise it once, immediately — this is the smoke test deliberately
left out of §7, since the Worker did not exist at that point:

```bash
wrangler tail vaipakam-offchain-data-archive
# Trigger the cron manually from the CF dashboard's "Trigger" button.
```

The run should produce a fresh archive plus a green Telegram alert. It is
safe to trigger here precisely because §§4–5 have already restored the
data — the archive it writes is of the RESTORED account, not an empty one.

Confirm one clean nightly before considering the restore complete — the
first successful unattended run is the evidence that the whole pipeline,
not just the Worker, came back.

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
