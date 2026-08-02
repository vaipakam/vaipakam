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
- **`CF_ACCOUNT_ID` (exported) and `CF_API_TOKEN` (shell variable,
  NOT exported) set in the shell.** Three
  commands in this document read them and nothing assigns them, so on the
  clean recovery workstation this document assumes, the URL silently becomes
  `/accounts//workers/...` and the API answers with a shape that is not an
  error you would notice. Set them before starting:

  Set them AFTER §1 step 1 creates the account — on a fresh-account recovery
  there is no account id to export before that, so this cannot be a
  before-you-start item (#1450 r24):

  ```bash
  # `wrangler whoami` needs Wrangler to be AUTHENTICATED first, which on a
  # clean workstation it is not (#1450 r25) — it would print "not logged in"
  # and there would be no id to copy. Either log in interactively, or set the
  # token FIRST and let whoami use it:
  wrangler login          # OR: export CLOUDFLARE_API_TOKEN=<token>
  # The id is also the `/accounts/<id>/` segment of any dashboard URL, which
  # is the faster route if you are already in the dashboard creating things.
  wrangler whoami
  export CF_ACCOUNT_ID=<the account id from above>
  # Token scopes: Workers Scripts:Read (plus Edit for the deploy steps) AND
  # Account Settings:Read — the last one is what the validation below calls,
  # and a token without it fails that check while being perfectly usable for
  # everything else, which reads as a wrong account id.
  read -rs CF_API_TOKEN   # not via argv, not in history — and NOT exported:
  # the heredoc below is expanded by THIS shell, so a plain variable works,
  # while `export` would copy the token into the environment of every
  # wrangler / pnpm / node / curl child spawned for the rest of the restore
  # (readable via /proc/<pid>/environ and child diagnostics). Later steps
  # that need the token re-prompt for it. Unset it as soon as the check
  # below passes (#1450 r32):

  # Prove the PAIR, not just the token. `/user/tokens/verify` says the token is
  # valid and says NOTHING about whether CF_ACCOUNT_ID is right or reachable
  # with it — which is the half that was silently wrong. An account-scoped
  # request exercises both:
  curl -sS --fail-with-body -K - <<HDR | jq -e '.result.name'
  url = "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID"
  header = "Authorization: Bearer $CF_API_TOKEN"
  HDR
  ```

  A non-zero exit or a null name here means the id is wrong, the token cannot
  see that account, or the variable is empty — all three of which otherwise
  surface later as a `/accounts//workers/...` URL and a response shape nobody
  reads as an error. When it passes, `unset CF_API_TOKEN` — the sections
  that need it again re-prompt at the point of use.

- **Offline copies of every Worker secret.** The B2 archive backs up D1
  rows and R2 objects ONLY. Nothing in it restores the
  `vaipakam-credentials` Secrets Store or the per-Worker secrets — the
  per-chain RPC URLs (which carry API keys), `KEEPER_PRIVATE_KEY`,
  `PUSH_CHANNEL_PK`, `TG_BOT_TOKEN`, `DIAG_WALLET_HMAC_KEY`, the
  0x / 1inch / OpenSea keys, the Alchemy webhook signing keys, and the
  archive Worker's own nine. An operator holding only the AES key and the
  B2 read keys will get as far as the deploy step and stop. Treat this
  bullet as the reason the list above is not exhaustive.
- A workstation with `wrangler ≥ 4`, `node ≥ 22`, `pnpm` (the pinned
  version — corepack reads `packageManager` from the repo root),
  `openssl`, `curl`, `jq`, and the **Backblaze `b2` CLI** (a major
  version whose `b2 file download` accepts the `b2://` / `b2id://`
  URI forms §2 uses — check `b2 version` / `b2 help` before relying
  on it). None of these are vendored in the repository; §2 stops at
  its first command on a workstation without the `b2` CLI (#1450
  r32).
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

   > ⚠️ **BRANCH ON WHY YOU ARE HERE, before you copy anything forward.**
   > The steps below re-upload the saved values verbatim, which is correct
   > for a **lockout, billing dispute or deploy mistake** — nobody else has
   > seen them.
   >
   > It is wrong for a **compromise**, and this runbook establishes why a
   > few lines above: Workers Edit lets an attacker deploy code that reads
   > every binding. If that is the incident, the attacker already holds the
   > keeper signer, the Push channel key, the Telegram bot token, the RPC
   > URLs with their embedded API keys, the Alchemy webhook signing keys,
   > the diagnostics HMAC key, and — per the same analysis — the B2 read
   > credentials **and** the archive AES key. Copying them into the
   > replacement account hands the new deployment straight back to them,
   > and the cutover reads as a successful recovery.
   >
   > For a compromise, the credential step is a **rotation**, not a
   > restore. Before deploying:
   >
   > - **`KEEPER_PRIVATE_KEY`** — generate a fresh EOA and fund it. Then,
   >   and this is the part that is easy to get wrong: **REVOKE the old
   >   EOA's on-chain authorities. Sweeping its gas is housekeeping, not
   >   revocation** — a swept EOA keeps every permission it held, and an
   >   attacker can fund it again for a few cents. There are **two distinct
   >   authorities**, and revoking one does not touch the other:
   >
   >   1. **`KEEPER_ROLE`, on EVERY chain including canonical Base** — not
   >      mirrors only. `ConfigFacet.setKeeperTier` is `KEEPER_ROLE`-gated
   >      and deployed everywhere, and it feeds loan-init LTV limits, so a
   >      retained role on Base is a live risk-affecting write. Also
   >      `RewardCommitmentFacet.submitCommitmentBatch` and
   >      `ClaimFacet.claimAsLenderViaBackstop`. Revoke from the old
   >      address, then grant to the new one, per chain.
   >   2. **`rewardRemittanceKeeper` on Base** — a SEPARATE authority.
   >      `remitRewardBudget` authorises through `_checkRemitter`, which
   >      accepts ADMIN **or** the configured `rewardRemittanceKeeper` — it
   >      does not consult `KEEPER_ROLE` at all. So revoking the role
   >      leaves the stolen EOA still able to remit reward budget.
   >      Repoint it with `setRewardRemittanceKeeper(<new EOA>)`.
   >
   >   Read both back per chain before re-arming. This is also what makes
   >   on-chain reauthorisation genuinely necessary here, which it is *not*
   >   on a non-compromise restore (see §7a).
   > - **`TG_BOT_TOKEN`** — @BotFather `/revoke`, re-issue, re-register the
   >   webhook (IncidentRunbook §4).
   > - **`PUSH_CHANNEL_PK`** — a channel **migration**, not a signer swap;
   >   there is no ownership transfer. Budget the 50-PUSH stake and expect
   >   to ask subscribers to re-subscribe (IncidentRunbook §4).
   > - **`RPC_*`, `ZEROEX_API_KEY`, `ONEINCH_API_KEY`, `OPENSEA_API_KEY`**
   >   — re-issue upstream, then upload the new values. The old ones remain
   >   billable to us until revoked.
   > - **`ALCHEMY_WEBHOOK_SIGNING_KEY_*`** — rotate at Alchemy; a retained
   >   key lets an attacker forge chain events into the indexer.
   > - **`DIAG_WALLET_HMAC_KEY`** — **do NOT rotate this one blind; it is not
   >   a like-for-like swap.** `wallet_hash` is
   >   `HMAC(lowercased_full_wallet, DIAG_WALLET_HMAC_KEY)` and the full
   >   address is deliberately never stored, so the key is the ONLY way a row
   >   maps back to a wallet. Rotate it and every restored diagnostics and
   >   legal-hold row becomes permanently unreachable by wallet — erasure
   >   requests, their status endpoint, and every legal-hold action recompute
   >   the hash under the current key and will simply not find rows that
   >   exist. Re-keying is impossible: it needs the plaintext addresses,
   >   which is exactly what we chose not to keep.
   >
   >   Note also what rotation does NOT buy. The key pseudonymises; it does
   >   not authenticate. An attacker who read it can already de-anonymise the
   >   rows they saw, and a new key does not undo that. So the real choice is
   >   between two coherent options — keep the key and retain
   >   wallet-addressability of prior rows, or **purge the pre-rotation
   >   diagnostics rows and then rotate**, which resolves the exposure and
   >   the orphaning together. Purging is usually right: the rows are
   >   diagnostics, and any that are under legal hold must be resolved
   >   first — check that before purging, not after.
   > - **`TG_OPS_BOT_TOKEN`** — easy to miss, and it was: it is a per-Worker
   >   secret rather than a store binding, so it is absent from the binding
   >   lists this section is otherwise driven by. It was equally readable to
   >   the attacker, and it authorises posts to the **operator** channel —
   >   so a retained token lets them spoof backup outcomes, healthcheck
   >   verdicts and support-ticket alerts throughout the recovery and after
   >   it. That is worse than the user-facing bot: those are the signals
   >   **you** are acting on while you work. @BotFather `/revoke`, re-issue,
   >   and upload the replacement to **every** consumer —
   >   `ops/offchain-data-archive` AND `apps/agent` (steps 6d and 6e below,
   >   which otherwise re-upload the saved token verbatim). `TG_OPS_CHAT_ID`
   >   is not a credential and needs no rotation.
   > - **`BACKUP_ENCRYPTION_KEY` + `B2_*`** — rotate the B2 keys **FIRST**,
   >   before anything else in this branch, so no further attacker uploads
   >   can land while you are restoring. **Rotate KEY-ONLY, via the B2
   >   console's App Keys page (or the B2 CLI's key create/delete
   >   commands — check `b2 help`, the subcommand names differ across
   >   CLI major versions) — do NOT re-run `setup-backblaze.mjs` to
   >   rotate.** That script is
   >   bucket-provisioning, not key rotation: it calls
   >   `setLifecycleRules()` before it touches either key, overwriting
   >   whatever rules are live on the bucket with this tree's
   >   provisioning values (`daysFromHidingToDeleting: 1`). During a
   >   compromise that can silently collapse the hidden-version window
   >   §2 depends on to about a day — deleting the genuine versions you
   >   are about to go looking for (#1450 r28). Create the two
   >   replacement scoped keys with the same capability sets
   >   (write-only: `listBuckets` + `writeFiles`; read-only:
   >   `listBuckets` + `listFiles` + `readFiles`), delete the old
   >   ones, and leave the bucket's lifecycle rules untouched. Then
   >   treat the archive history as
   >   **attacker-WRITABLE, not merely readable** — see the archive-
   >   selection warning in §2, which changes how you pick an archive. Do
   >   NOT re-encrypt the existing history forward before selecting (§8):
   >   re-encrypting a poisoned set under a fresh key preserves the poison
   >   and removes the one signal that distinguished it.
   >
   > Rotate **before** the deploy where you can, so no window exists in
   > which the new account runs on known-compromised values. Where a
   > rotation needs the platform live (the Push migration), deploy with the
   > old value, rotate immediately after, and record the window.

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

   f. The keeper's **operational flags** are not in the archive and are not
      committed — so a restore that follows only the steps above completes
      with the signing key present and every autonomous path dark,
      indefinitely and silently.
      `apps/keeper/wrangler.jsonc` describes them as "operator-managed vars
      (non-secret config — plain `vars`)" and its committed `vars` block
      carries only `TG_BOT_USERNAME`. **That description is wrong and this
      matters for capture, not just for tidiness.** Verified against the live
      deployment (2026-07-30): `KEEPER_ENABLED` is a per-Worker
      **`secret_text`** binding, and §7a step 3 restores it with
      `wrangler secret put` accordingly. Correcting the config comment is
      #1465.
      The consequence here: a `secret_text` value **cannot be read back**,
      from the API or the dashboard. So capturing these offline is not
      optional convenience — it is the only record that will exist, and an
      operator who assumes they can be re-read later will find they cannot:

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

   > **Bind the PUBLIC hostnames LAST, not here.** The indexer's route is
   > forced by its own config, so that one is unavoidable at this point —
   > but every hostname below is bound **by hand**, which makes the timing a
   > choice, and binding them now publishes a migrated-but-EMPTY database
   > hours before §§4–7 restore and verify it. Two concrete consequences:
   >
   > - users reach a working-looking site showing no offers, no loans and no
   >   history, and draw conclusions from it;
   > - `apps/agent`'s HTTP **write** endpoints are live even though its cron
   >   is disabled — step 9's cron note stops *scheduled* work, not fetch
   >   handlers — so users can create thresholds, Telegram links,
   >   diagnostics and support tickets **while §4 is importing those very
   >   tables**, mixing new rows into a restore whose row counts you are
   >   about to verify.
   >
   > Deploy the Workers here so bindings validate, and bind
   > `agent.vaipakam.com`, `defi.vaipakam.com`, the apex and `www` in **§7
   > step 4**, which exists for exactly this ("update DNS / frontend env
   > vars to point at the new Worker subdomains") and sits after the smoke
   > test. Having to activate the zone early for the indexer's sake is not a
   > reason to bind the rest early too.

   Every OTHER Worker is the opposite shape: it declares no route, so its
   hostname must be bound by hand in the dashboard after deploy. That
   includes both public surfaces — `apps/defi` and `apps/www` are
   **Workers Static Assets** deployments, NOT Pages projects, so nothing
   in their configs attaches a domain and deploying them leaves the sites
   reachable only on their `*.workers.dev` URLs.

   **Bind these in §7 step 4, NOT here.** The list below is the inventory of
   what must eventually be bound; it is not a step to perform at this point
   in the restore. Binding the public hostnames right after these early
   deploys puts the production origins in front of a migrated-but-EMPTY
   database for the hours §§4–7 take to restore and verify it — and the
   agent's HTTP write endpoints stay live even with its cron disabled, so
   users can create thresholds, links, diagnostics and tickets while those
   same tables are being imported, producing conflicts and a mixed state
   nothing has checked.

   Reaching the Workers before then is still necessary — the §7 smoke test
   has to hit them — so use their `*.workers.dev` origins for every
   pre-cutover build and check, and switch `apps/defi/.env.production` to
   the real hostnames as part of the §7 cutover. Leaving the zone inactive
   without staging those temporary origins is the failure in the other
   direction: the smoke test then has nothing to reach.

   The inventory, for §7 step 4:

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
   > **The indexer needs one MORE thing switched off — the cron is not its
   > only writer.** `apps/indexer/wrangler.jsonc` commits
   > `CHAIN_INGEST_VIA_DO: "true"` and a custom domain, and
   > `POST /hooks/chain-event` forwards every authenticated Alchemy
   > delivery into `ChainIngestDO`, whose alarm runs the D1 indexer. So the
   > moment the replacement route answers, pre-existing webhooks resume
   > writing rows and advancing cursors — the exact race an empty cron list
   > was meant to prevent, arriving through a different door.
   >
   > Close that door too, by either: setting `CHAIN_INGEST_VIA_DO` to
   > `"false"` for this deploy (the flag exists precisely as a two-step
   > rollout switch), **or** leaving the custom domain unattached until §6.
   > Pausing the webhooks at Alchemy works as well and is the belt to that
   > braces. Whichever you choose, re-enable it in the same step that
   > restores the indexer's schedule, after the cursor reset.
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
   pnpm --filter @vaipakam/indexer run deploy
   pnpm --filter @vaipakam/keeper run deploy
   pnpm --filter @vaipakam/agent run deploy
   ```

   `run` is load-bearing: under the pinned pnpm 10.4.1, bare
   `pnpm --filter <pkg> deploy` resolves to pnpm's **builtin**
   portable-package command (which demands a target directory and
   never runs the package's script), so every **pnpm-driven** deploy
   in this runbook uses the `run deploy` form. (The direct
   `wrangler deploy` and ops-Worker `npm run deploy` invocations
   elsewhere in this document are unaffected — the collision is
   pnpm-specific.) (#1450 r28; the same fix outside this document's
   file set is #1478.)

   THEN provision origins — this is a real pause, not a formality:

   - do **NOT** create `apps/agent`'s custom domain here. The step-8 warning
     moves that binding to §7 step 4, and this instruction contradicted it —
     following the runbook in order still published the agent's HTTP write
     endpoints before §§4–6 restore the database, letting users insert
     thresholds, Telegram links, diagnostics and tickets into the very
     tables being imported and row-counted. Use its `*.workers.dev` origin
     for the pre-cutover build and bind the real hostname in §7;
   - note the new `indexer` subdomain, and the agent's `workers.dev` origin;
   - set `VITE_INDEXER_ORIGIN` / `VITE_AGENT_ORIGIN` in
     `apps/defi/.env.production`.

   ONLY THEN build and deploy the frontends. Vite embeds those origins at
   BUILD time, so a bundle produced before this point calls the lost
   account's hosts and editing the env afterwards changes nothing:

   ```bash
   pnpm --filter @vaipakam/defi run deploy
   pnpm --filter @vaipakam/www run deploy
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
> scratch. A selective restore still starts at **§2** (archive
> selection — and for tampering the compromise rules there apply in
> full), then **§3** to decrypt, then the relevant **§4** table
> import or **§5** legal-vault object. It skips only the
> account-rebuild steps of §1, not the selection and decryption that
> every restore path needs.
>
> Two preconditions are NOT skippable just because the account
> survives (#1450 r30):
>
> - **Quiesce every writer of the affected tables first**, exactly as
>   §1 step 9 does for a rebuild: empty the cron lists of the Workers
>   that write them and close the indexer's second writer (the
>   DO/webhook ingest — see §6's both-writers note) where an indexer
>   table is involved. **Crons are not the only writers — the agent's
>   HTTP fetch handler mutates these same tables** (thresholds,
>   Telegram links, support tickets, diagnostics, erasure, legal
>   holds — `apps/agent/src/index.ts`), and it stays reachable
>   through the custom domain and its `workers.dev` origin no matter
>   what the schedules say. Detach the agent's custom domain and
>   disable its `workers.dev` route (Worker → Settings → Domains &
>   Routes) for the duration, the same way the rebuild path withholds
>   that domain until §7. The per-Worker READMEs carry the write/read
>   split. A live writer during the §4 delete → import → count
>   sequence can re-insert rows between replacement and verification,
>   delete restored rows in a retention pass, or leave a mixed
>   snapshot the instant a count passes. Restore and verify with the
>   writers stopped; re-arm afterwards with the same staged order §6
>   and §7a use for the rebuild path — **plus one step those sections
>   do not cover: re-attach the agent's HTTP origins.** §6 re-arms
>   only indexer ingest and §7a only the schedules, so on the
>   selective path the domains detached above stay detached until you
>   explicitly re-enable `workers.dev` and re-attach the custom
>   domain after verification. Skipping that leaves thresholds,
>   Telegram links, tickets, diagnostics, erasure and legal holds
>   unreachable in production while every checklist reads green
>   (#1450 r32).
> - **Restoring the indexer's derived tables goes through §6's
>   clear-before-replay, not through §4.** Only born-off-chain tables
>   are imported from the archive; the derived set is re-derived into
>   cleared tables, for the reason §6 states.

---

## 2. Download the most recent archive from B2

> ⚠️ **AFTER A COMPROMISE, "most recent that verifies" IS THE ATTACK.**
> Skip to the selection rules below before running anything in this
> section. On a lockout / billing / deploy-mistake restore the ordinary
> newest-first flow is correct and this box does not apply.
>
> The archive Worker's B2 key carries `writeFiles`, and per §1 step 6 a
> Workers Edit compromise also yields the raw `BACKUP_ENCRYPTION_KEY`. With
> both, an attacker can upload a **newer** nonce-keyed archive plus a
> matching manifest, encrypted under the stolen key and self-consistently
> checksummed. Every verification in this section then **passes**: the
> manifest's SHA-256 matches the object because they computed it, the byte
> length matches, and AES-GCM decrypts and authenticates because it is the
> real key. The `sort … | tail` step selects it precisely *because* it is
> newest, and §§4–5 then restore attacker-chosen D1 rows and R2 objects
> into the replacement account.
>
> **The checks in this section prove INTEGRITY, not PROVENANCE.** SHA-256
> and GCM tell you an object is intact and was encrypted under our key.
> They cannot tell you *who* encrypted it. That distinction is the whole
> vulnerability, and nothing downstream re-establishes it.
>
> So for a compromise, select by **time, not by recency**:
>
> 1. **Rotate the B2 keys first** (§1 step 6) so nothing new can land
>    mid-restore.
> 2. **Establish the earliest possible compromise time** — first unexplained
>    deploy, first anomalous access, or if unknown the last moment you can
>    positively account for. Treat **every object uploaded at or after it as
>    attacker-controlled**, however well it verifies.
> 3. **Choose an archive dated safely BEFORE that window** and accept the
>    extra data loss. A few days of born-off-chain rows is recoverable
>    ground; a restore of attacker-chosen legal-hold and support-ticket rows
>    is not.
> 4. **Do not rely on the naming nonce to preserve the genuine archive.** An
>    earlier revision of this step claimed it did — that a forgery must land
>    under a different nonce, so the original survives beside it and two
>    objects under one date is evidence of tampering. **Verified against the
>    live bucket, that is wrong**, and wrong in the unsafe direction:
>
>    - the read key carries `listFiles`, so an attacker can enumerate the
>      genuine nonce and upload a new version **at that exact key**. The
>      ordinary listing then shows one nonce and the download returns the
>      forgery;
>    - **Object Lock is not enabled** on `vaipakam-offchain-data-archive`
>      (`isFileLockEnabled: false`, no default retention), so nothing makes
>      any object immutable;
>    - the genuine copy persists only as a hidden older VERSION, and only for
>      as long as `daysFromHidingToDeleting` on those prefixes allows.
>      **Read that number off the LIVE bucket, and trust nothing else** —
>      `b2_list_buckets` (or the bucket's Lifecycle Settings in the console)
>      returns the rules in force. Do NOT infer it from this repo: the only
>      committed source on this branch is `scripts/setup-backblaze.mjs`, whose
>      provisioning values are **stale** (it still writes `1`), and a previous
>      revision of this step pointed at a declaration file and an
>      `npm run bucket:lifecycle:print` helper that exist only on the
>      unmerged #1469 branch — so the instruction could not be followed at all
>      (#1450 r27).
>      For orientation only, live was set to **9** days on the daily prefixes
>      and 31 on the monthly on 2026-07-30. Treat that as a date-stamped
>      observation, not as the authority: if the live rules say 1, you have
>      about a day, whatever any document here claims.
>
>    So list **file VERSIONS**, not files, and do it early — inside whatever
>    the overwrite is the whole window. List **every tier you might select
>    from, on both sides**: an attacker who overwrote the archive but not
>    its manifest (or vice versa) is visible only on the side you looked
>    at — and step 5 below establishes that when the window is old, the
>    monthly/yearly tiers are the only candidates, so an overwrite there
>    matters exactly as much as one in the dailies:
>
>    ```bash
>    for p in manifests/ archives/ manifests-monthly/ archives-monthly/ \
>             manifests-yearly/ archives-yearly/; do
>      b2 ls vaipakam-offchain-data-archive --recursive --long --versions "$p"
>    done
>    ```
>
>    More than one version at a key is strong evidence of tampering. One
>    version is **not** evidence of safety: the original may already have
>    aged out.
>
>    **Record the FILE IDs of the versions you select, and download by ID.**
>    The `--versions` listing prints a file id per version; the
>    key-addressed download in step 2.3 (`b2 file download "b2://…"`)
>    always fetches the CURRENT version of a key — under an in-place
>    overwrite, that is the forgery you just identified, however carefully
>    you chose. When the pre-compromise object survives only as a hidden
>    older version, fetch **both the manifest and the archive** by their
>    captured ids instead:
>
>    ```bash
>    b2 file download "b2id://<manifest-file-id>" ./restore/manifest.json
>    b2 file download "b2id://<archive-file-id>"  ./restore/archive.bin
>    ```
>
>    Then continue with the same SHA / byte-length / row-count checks —
>    remembering what this box already established: those checks prove
>    integrity, not provenance.
>
>    Making a forged overwrite *impossible* rather than
>    detectable-within-a-day needs Object Lock on the bucket, which is a
>    configuration decision with cost and irreversibility consequences —
>    tracked as **#1469**.
>
> 5. **Mind the retention floor.** A prefix's reach is the SUM of both terms,
>    since a version is deleted `daysFromHidingToDeleting` after it is hidden —
>    reasoning about the first term alone understates it. Read both off the
>    live bucket (see step 4); the repo cannot tell you on this branch.
>    Live as of 2026-07-30: `archives/` + `manifests/` reach ~29 days
>    (hidden at 20, deleted 9 later), `archives-monthly/` +
>    `manifests-monthly/` ~365 (334 + 31). Both sums are capped by published
>    privacy promises, so they are facts about the product rather than
>    tunables. If the compromise window opened more
>    than a month ago, **the daily series cannot supply a clean archive at
>    all** and the monthly ones are the only candidates.
> 6. **Cross-check what you can from outside B2.** The re-derivable tables
>    are rebuilt from chain in §6, so poisoning those is corrected by the
>    replay — **but only because §6 clears those tables before resetting
>    the cursor**. The replay upserts by key and never deletes fabricated
>    rows on its own, so "re-derive from chain" is only self-correcting
>    over empty tables (#1450 r30). The exposure that no replay can fix is
>    the born-off-chain set. Compare the manifest's row
>    counts against any out-of-band record you hold (monitoring history, the
>    ops Telegram backup notifications) before restoring them.
> 7. **Do not re-encrypt the history forward until after selection.**
>    Re-encrypting under a fresh key launders the poisoned objects into the
>    new key's set and destroys the upload-time signal you just used.
>
> If no archive predates the window, the born-off-chain data cannot be
> trusted from this channel at all; restore the re-derivable half from chain
> and treat the rest as an incident with its own decision, not a runbook
> step.

Archive + manifest object keys carry a 32-hex-char nonce per upload. This was
designed as an immutable-naming guard against in-place overwrite, and **it does
not hold against a Worker compromise** — see the warning above. The guard
assumed an attacker could not learn an existing nonce, which is true of the
write key alone (`listBuckets` + `writeFiles`, no `listFiles`), but the Worker
binds the READ key beside it (`B2_READ_ACCESS_KEY_ID`), and that one carries
`listFiles`. One environment yields both, so the separation the guard rests on
is defeated exactly where it was meant to matter. Treat the nonce as an
operational convenience, never as tamper-evidence. The layout is:

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
#     COMPROMISE PATH: these key-addressed downloads fetch the
#     CURRENT version of each key. If you selected a hidden older
#     version in the warning box above, download by FILE ID
#     (`b2id://…`) as shown there instead of running these two.
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

2. Convert each archived table's `rows[]` array into a
   `restore/d1/<table>.sql` `INSERT` batch, using the **committed,
   tested converter** (#1477):

   ```bash
   ( cd ops/offchain-data-archive && \
     node scripts/restore-from-archive.mjs /path/to/decrypted-archive.json \
       --outdir /path/to/restore )
   ```

   It writes one batch per table under `restore/d1/` (and
   `restore/d1-lz-alerts/` for a pre-#1440 archive's `lzAlerts`
   section — pass `--lz-db <name>` if you created that legacy
   database above under a custom name, so the printed commands
   target the database you actually made), prints the
   `wrangler d1 execute` commands **in FK apply
   order**, and covers §5's R2 materialization in the same run. Its
   test suite (`scripts/restore-from-archive.test.mjs`, run in CI)
   pins the hostile-input rejections. This document deliberately
   contains no inline script — two earlier revisions carried code
   that presented as runnable and was not (#1450 r28), which is
   worse than no code: it fails at the moment of use. The converter
   implements these requirements, which remain the spec if it ever
   needs to be reproduced by hand:

   - one output file per table, named `restore/d1/<table>.sql`
     (`restore/d1-lz-alerts/<table>.sql` for a legacy `lzAlerts` section);
   - **each file begins with `DELETE FROM <table>;`** so the import
     REPLACES the table instead of merging into it. On a fresh
     account (tables just created by §1 step 7's migrations) the
     delete is a no-op; on a **selective restore into a live
     database** it is load-bearing twice over — archived rows
     collide with surviving primary keys and abort a plain-INSERT
     import, and rows an attacker INSERTED are untouched by inserts
     alone even where they succeed (#1450 r29). `INSERT OR REPLACE`
     is not a substitute: it resolves the collisions and still
     leaves the attacker-added rows in place;
   - **import parents before children, and re-import every cascading
     child whenever a parent is replaced.** `notify_state` and
     `pre_grace_notify_state` both declare `ON DELETE CASCADE`
     foreign keys onto `user_thresholds`, so the `DELETE FROM
     user_thresholds` that replacement requires erases both children
     as a side effect — including a child restored and verified
     moments earlier, if the tables were processed in the wrong
     order (#1450 r30). So: `user_thresholds` first, then
     `notify_state` and `pre_grace_notify_state` from the same
     archive. (`pre_grace_notify_state` is archived since #1480 —
     archives written before that fix do not carry it; restoring
     from one loses those rows, and the observable consequence is
     duplicate pre-grace notifications, not data damage);
   - values quoted safely — single-quote doubling for strings, bare
     numerics, `NULL` for null, and a hard failure on any value type
     the script does not recognise;
   - identifiers (table and column names) treated as untrusted input
     too: after a compromise, `archive.json` is attacker-influenced;
   - per-table row counts printed, for step 4's verification — and
     because the import is replace-not-merge, the post-import `SELECT
     COUNT(*)` must EQUAL the manifest count, with no allowance for
     pre-existing rows.

3. Apply via wrangler — targeting the matching D1 binding:

   **`vaipakam-archive` tables** (born-off-chain): `diag_errors`,
   `diag_legal_holds`, `diag_legal_hold_audit`, `user_thresholds`,
   `notify_state`, `pre_grace_notify_state` (absent from pre-#1480
   archives), `telegram_links`, `support_tickets`.

   ```bash
   wrangler d1 execute vaipakam-archive --file=restore/d1/<table>.sql --remote
   ```

   **`vaipakam-lz-alerts-db` tables** (lz-watcher): `lz_alert_state`,
   `scan_cursor`, `oft_balance_history`.

   ```bash
   wrangler d1 execute vaipakam-lz-alerts-db --file=restore/d1-lz-alerts/<table>.sql --remote
   ```

4. Verify row counts match the manifest before moving to the next
   table.

---

## 5. Restore the R2 legal-vault

For each object in the decrypted `r2.objects[]`, five things must
happen locally **before** any upload — **validate the key**, decode
`base64Body`, create the parent directories (`mkdir -p` semantics:
legal-vault keys contain `/` separators), write the bytes to
`restore/r2/<key>`, and verify the per-object SHA-256 against the
archive's recorded value. Only then upload.

**The §4 converter run already did all five** — the same
`restore-from-archive.mjs` invocation materializes and SHA-verifies
every object under `restore/r2/`, and re-running it with `--upload`
performs the uploads via argv-array `wrangler r2 object put` calls
(#1477). The requirements below remain the spec the converter's
tests pin.

**Key validation comes first because `obj.key` is untrusted input**
— after a compromise the archive is attacker-influenced, and a key
like `../../.ssh/authorized_keys` walks the write right out of the
staging tree; the argv-array upload safeguard below prevents shell
injection, not filesystem traversal (#1450 r31). Reject any key
that is absolute, contains a `..` segment, or whose resolved path
does not remain beneath `restore/r2/`. The vault's canonical key
shape is `legal-holds/<64-hex-sha256>.pdf` (generated at
`apps/agent/src/diagLegalDoc.ts`), so a shape check is cheap —
treat anything that deviates as a reason to stop and look, not to
skip silently.

**This document deliberately contains no inline
materialize-and-upload script.** Earlier revisions carried both an
illustrative fragment (not runnable on its own) and an "executable"
heredoc that skipped the materialization entirely and handed wrangler
paths to files that were never written (#1450 r28). The committed,
tested tooling that replaced them is
`ops/offchain-data-archive/scripts/restore-from-archive.mjs` (#1477 —
one script covering both this section and the §4 SQL conversion);
its tests pin the requirements above plus the two pitfalls below.

Two pitfalls to avoid:

1. **Don't iterate via `find . -type f`** — that emits paths like
   `./legal-holds/<sha256>.pdf` whose leading `./` would become
   part of the R2 object key. The restored D1's `legal_doc_ref`
   rows reference the ORIGINAL keys (`legal-holds/<sha256>.pdf`),
   so a `./`-prefixed key would silently break every legal-document
   lookup. Iterate by archived `obj.key` instead.
2. **Don't interpolate `obj.key` into shell strings** — a key that
   contains a single quote / dollar sign / backtick would break the
   shell command (or worse, execute attacker-controlled fragments
   when restoring an archive whose write key has leaked). Use
   `child_process.spawnSync` with an argv ARRAY (target
   `vaipakam-legal-vault/<key>`, `--file restore/r2/<key>`,
   `--remote`) so wrangler receives each argument verbatim, no shell
   parsing — and treat a non-zero exit as fatal rather than
   continuing to the next object.

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
# Clear EVERY replay-derived table, then the cursor, so the replay
# starts from genesis into empty tables.
wrangler d1 execute vaipakam-archive --remote --command="\
DELETE FROM activity_events; \
DELETE FROM loan_participants; \
DELETE FROM notifications; \
DELETE FROM hf_band_state; \
DELETE FROM swap_to_repay_intents; \
DELETE FROM loans; \
DELETE FROM offers; \
DELETE FROM oracle_snapshot_state; \
DELETE FROM liquidity_confidence; \
DELETE FROM recycle_day_pool; \
DELETE FROM recycle_series_events; \
DELETE FROM recycle_series_state; \
DELETE FROM recycle_prelaunch; \
DELETE FROM indexer_cursor"
```

Clearing the tables is not optional, and resetting only the cursor
is NOT equivalent: the replay handlers upsert by key and **never
delete a row for which no chain event exists**. Against a tampered
database, a cursor-only reset replays real history over the top of
fabricated rows and leaves every attacker-added offer or loan
standing after the runbook declares the index healthy (#1450 r30).
Empty tables are what make "re-derive from chain" an
integrity-restoring operation rather than a merge with the
attacker's writes. (`loan_participants` is replay-derived —
append-only `INSERT OR IGNORE` chain history. `swap_to_repay_intents`
likewise: its only writers are the `SwapToRepayIntent*` handlers in
`chainIndexer.ts` — verified repo-wide, no HTTP or keeper/agent
writes — so a fabricated pending intent would otherwise survive
replay as a visible user action. #1450 r31/r32.)

**`notifications` is cleared with its producer state, and the loss
boundary is stated honestly** (#1450 r33). The table has THREE
producer classes, and "the replay regenerates it" is true of only
one: chain-event rows come back from the block-zero replay; the
keeper's HF-band rows come back only as *current-state* rows, and
only because `hf_band_state` is cleared in the same command — with
the state emptied, every loan reads as previously-healthy and the
keeper's first tick re-derives one fresh notification per
currently-degraded loan (day-bucketed dedup bounds this; it is
re-derivation, not a bug). Historical band crossings and
already-past calendar reminders do NOT regenerate — no chain event
encodes them. That loss is accepted under the inbox's
indexed-hints-only discipline (rows deep-link and re-verify; the
chain stays authoritative — see `0038_notifications.sql`), because
the alternative in a tampering recovery is preserving rows the
attacker may have written. Clearing `notifications` while LEAVING
`hf_band_state` would be the worst combination: the state says
"already notified" about rows that no longer exist, and current
degradations go silent.

**This list is the archive's re-derivable set plus the two tables
above, and it is NOT proven complete** — the schema has grown past
the lists `backup.ts` carries, and the full born-off-chain vs
replay-derived classification of every indexer table is **#1481**.
Until that audit lands, two rules bound the risk:

- clear ONLY tables you have confirmed are written by the replay
  path (`chainIndexer.ts` and the modules it invokes). If a table's
  provenance is unclear, resolve it before touching it;
- NEVER clear a table that HTTP routes populate — `signed_offers`
  (user-submitted, chain-updated, and currently not archived at
  all — see #1481) is the standing example: clearing it destroys
  user data no replay can regenerate. Two more resolved-NOT-clearable
  while verifying this round: `prepay_listing_match_breadcrumbs`
  (HTTP-written via `loanRoutes.ts`) and
  `keeper_commitment_reconciled` (also written by the keeper).
  `prepay_listings` stays with #1481 for a different reason: its
  replay handlers invoke OpenSea publishing, so whether a
  clear-and-replay is side-effect-free is an open audit question,
  not a grep.

**Only now re-arm the indexer's ingest — BOTH of its writers.** The cursor
reset above is exactly the precondition §1 step 9 held them back for.
Restore `"triggers": { "crons": ["* * * * *"] }` in
`apps/indexer/wrangler.jsonc`, restore whichever webhook path you closed in
step 9 (`CHAIN_INGEST_VIA_DO` back to `"true"`, and/or attach the custom
domain, and/or unpause the Alchemy webhooks), then redeploy that Worker
alone. Re-arming either one before the reset would have had it write from
whatever cursor it found and then be reset out from under itself
mid-write — and restoring only the cron while leaving the webhook path open
would have let the DO keep writing throughout §§4–6 regardless.

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

1. **Restore the AGENT's schedule and redeploy** — not the keeper's; see the
   note below, and step 3 for the keeper. (This step said "both schedules"
   until #1450 r26, contradicting its own body and the note inside it.) Put
   `"triggers": { "crons": ["* * * * *"] }` back in
   `apps/agent/wrangler.jsonc` and deploy the **agent** — its notification
   and retention passes read and message only. Expect the first tick within
   a minute.

   > **The keeper's schedule is NOT read-only, so it is not restored here.**
   > `runDailyOracleSnapshot` checks only that `KEEPER_PRIVATE_KEY` is
   > present and then calls `writeContract` — it does **not** consult
   > `KEEPER_ENABLED`. Restoring the keeper cron therefore arms a
   > transaction-signing pass immediately, from a key this restore has just
   > re-uploaded, before anything has verified the signing configuration.
   > If the schedule is restored during 00:00–00:09 UTC with no
   > current-day `oracle_snapshot_state` row, it broadcasts on the first
   > tick. Treating the keeper tick as "reads and alerts only" was wrong —
   > that is true of its *other* passes, not of this one. Its schedule goes
   > back in step 3, together with the signing configuration it implies.
   > Gating that pass behind `isKeeperEnabled` like every other signing
   > pass is a code fix, tracked as #1466.

2. **Watch one full agent tick before going further.**

   ```bash
   wrangler tail vaipakam-agent
   ```

   A first tick that throws on a missing table or an empty binding means
   something in §§4–6 did not land; fix that before arming anything that
   signs. The agent's notification passes send real user messages from
   this moment — if the restore is long enough that state has gone stale,
   expect a burst.

3. **Only then restore the keeper — schedule and flags together**, from
   the offline record captured in §1 step 6f. Both arm signing from a real
   key (the schedule via `runDailyOracleSnapshot`, the flags via everything
   else), so they belong at the same, last step rather than being split
   across a "safe" and an "arming" half that does not exist.

   Before deploying: confirm the keeper EOA is the address you expect and
   is funded on every chain it submits from. After deploying, watch one
   keeper tick.

   **How they are actually held, verified against the live deployment
   (2026-07-30) — because this document previously guessed, and guessed
   wrong.** On `vaipakam-keeper`, `KEEPER_ENABLED` is a **`secret_text`**
   binding (a per-Worker secret, set with `wrangler secret put`), NOT a var.
   `KEEPER_PRIVATE_KEY` is a `secrets_store_secret`. `TG_BOT_USERNAME` is the
   only genuine `plain_text` var. `REWARD_REMIT_ENABLED` and
   `REWARD_COMMIT_ENABLED` are **absent** — the reward passes are dark.

   `apps/keeper/wrangler.jsonc` describes all three flags as
   "operator-managed vars (non-secret config — plain `vars`)". The deployment
   does not match that comment. Trust the readback in step 4, not the comment
   (correcting it is #1465).

   So restore them **the way they are held**:

   ```bash
   ( cd apps/keeper
     wrangler secret put KEEPER_ENABLED )     # prompts; enter: true
   ```

   Set `REWARD_REMIT_ENABLED` / `REWARD_COMMIT_ENABLED` the same way, and
   only if they were on before.

   **Then restore the keeper's schedule — nothing else in this document
   does.** §1 step 9 replaced it with `"crons": []`, §7a step 1 restores
   only the *agent's* (deliberately: the keeper's schedule signs, so it is
   armed last), and the indexer's is restored in §6. `wrangler secret put`
   writes a secret; it does not register trigger events. Without this the
   restore finishes with every flag correct and every keeper tick stopped —
   liquidation, matching, remittance, commitment reporting and the daily
   snapshot all silently dead, with the settings readback showing green.

   ```bash
   ( cd apps/keeper
     # put "triggers": { "crons": ["* * * * *"] } back in wrangler.jsonc
     wrangler deploy --keep-vars
     wrangler deployments list | head )
   ```

   Confirm the schedule is registered before believing a tick will come:

   ```bash
   # UNQUOTED heredoc delimiter — `<<'HDR'` would suppress expansion and send
   # curl the literal string `$CF_API_TOKEN` as the bearer token (#1450 r21).
   # `-K -` keeps the token out of the process's argv either way; that is the
   # point of the form, and quoting it defeats the request instead.
   # `--fail-with-body` so a 401/404 is a non-zero exit rather than a
   # success-looking empty `.result`.
   curl -sS --fail-with-body -X GET -K - <<HDR \
     "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/vaipakam-keeper/schedules" | jq '.result'
   header = "Authorization: Bearer $CF_API_TOKEN"
   HDR
   ```

   An empty `schedules` array here means the deploy did not carry the
   trigger, and no amount of waiting will produce a tick.

   `REWARD_REMIT_ENABLED` has two further prerequisites, and on a
   NON-compromise restore **both are normally already satisfied** — so
   VERIFY them rather than assuming they need rebuilding:

   - **D1 migration `0044_keeper_remit_ack.sql`** is checked into
     `apps/indexer/migrations/`, so §1 step 7 applied it with every other
     migration. Confirm:
     `wrangler d1 migrations list vaipakam-archive --remote`.
   - **The on-chain authority.** Two of them, and they are not the same —
     this is the part that is easy to get wrong. `remitRewardBudget`
     authorises through `_checkRemitter`, which accepts `ADMIN_ROLE` **or**
     Base's configured `rewardRemittanceKeeper`, and **never consults
     `KEEPER_ROLE`**. So confirming `KEEPER_ROLE` on every mirror — correct
     for the commitment and tier-update duties — says *nothing* about
     whether remittance will work. Enable the flag on that evidence and
     every Base send fails while the pass logs as skipped. Read back
     **`getRewardRemittanceKeeper()` on Base** as well, and confirm it is
     the EOA you expect. Both authorities live on chain and survive losing
     the Cloudflare account entirely.

   Reauthorisation is only needed where the keeper key was actually
   **rotated** — the compromise branch in §1 step 6, not a lockout. An
   earlier revision claimed neither prerequisite survived a restore, which
   would have left remittance switched off indefinitely while it was ready;
   a later revision then deleted this block wholesale while correcting a
   different error in the same step.

   > **Do NOT use `--var` for these, and do not "helpfully" move them into
   > the committed `vars` block as part of a restore.** Either creates a
   > plain var beside the existing secret, and a var IS subject to
   > wrangler's delete-then-set behaviour (`wrangler deploy --help`: "will
   > delete all vars before setting those found in the Wrangler
   > configuration"). So the workaround would introduce exactly the
   > disarm-on-next-deploy fragility that the secret form does not have.
   >
   > An earlier revision of this step recommended precisely that, on the
   > strength of the config comment rather than the deployment. Whether these
   > flags *should* be committed vars — reviewable, but then needing
   > `--keep-vars` discipline — is a real question, and it is #1465's, not a
   > decision to take mid-restore.

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

   Note the settings endpoint lists a `secret_text` binding by NAME with no
   value. Only genuine `plain_text` vars show their values.

   **So this readback proves the binding exists and nothing about what it
   says, which is not enough.** `wrangler secret put` accepts whatever is
   typed at the prompt: `ture`, `True`, a trailing space, a pasted newline.
   Every one of those creates a perfectly healthy-looking `secret_text`
   binding that `isKeeperEnabled()` evaluates as **false**. The guards then
   return silently — that is the documented behaviour two paragraphs down —
   so neither this check nor a quiet log tail can tell a typo from a
   deliberate "off", and the restore completes with signing duties dark.

   A presence check cannot close this; only the running Worker can say how
   it resolved the value. After the keeper's schedule is restored above,
   confirm from the pass itself:

   ```bash
   ( cd apps/keeper && wrangler tail --format pretty ) &
   # Wait for one tick.
   ```

   **This works for `KEEPER_ENABLED` and NOT for the two reward flags** — a
   distinction worth stating, because an earlier version of this step claimed
   it covered all three:

   - `KEEPER_ENABLED`: `runAutoLifecycle` logs
     `autoLifecycle skipped: keeper disabled` on the false branch, so a tick
     distinguishes armed from mis-typed. If you see that line, the flag is
     present and wrong — re-enter it with
     `wrangler secret put KEEPER_ENABLED` and watch another tick.
   - `REWARD_REMIT_ENABLED` / `REWARD_COMMIT_ENABLED`: **not observable this
     way.** `runRewardBudgetRemit`, `runRemitAck` and `runCommitmentReport`
     each `return` at their flag guard with no log at all, so an armed pass
     with nothing to do and a pass reading its flag as false produce
     byte-identical output — silence. Nothing outside the Worker can tell
     them apart. Closing that is #1475 (a pass-start line per pass); until it
     lands, treat these two as **write-only**: re-enter the value rather than
     verifying it, and take the first successful remittance or commitment
     report as the confirmation.

   Do not conclude the restore is complete until a tick has been observed
   doing work for every flag where that is possible.

   Confirm each flag you intended is present and, where the value is
   visible, reads what you meant.
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

   Then **pause the archive Worker's schedule before enumerating** —
   disable the cron from the CF dashboard (Worker → Settings →
   Triggers) and note the time. If the rotation spans 03:17 UTC with
   the cron live, the Worker uploads a fresh OLD-key archive *after*
   your enumeration; steps 4–6 then switch the key, validate only
   new-key output, and destroy the old key — leaving that late
   archive (and its monthly/yearly siblings on a boundary date)
   permanently undecryptable (#1450 r31). Re-enable the cron after
   step 4; step 5's green nightly needs it back on.

2. Enumerate and download **every retained ciphertext across all
   three tiers** — `archives/` (daily), `archives-monthly/`, and
   `archives-yearly/` — to a local workstation. The backup writer
   populates all three (`backup.ts`), and the yearly tier is
   retained indefinitely: any object skipped here is **permanently
   undecryptable** the moment step 6 destroys the old key. An
   earlier revision said "the past 30 nightlies", which migrated the
   shortest-lived tier and stranded the two long-term ones (#1450
   r28).
3. For each archive: decrypt with the OLD key, re-encrypt with the
   NEW key, re-upload to B2 under the same object key (B2's
   versioning preserves the prior cipher-text version for the
   lifecycle retention window) — **and regenerate its sibling
   manifest in the same pass**. AES-GCM re-encryption produces new
   ciphertext, so the manifest's `archive.sha256` and `byteLength`
   no longer match; `runHealthcheck()` compares exactly those fields
   against the downloaded object, and §2's restore verification does
   the same. A rotated archive under a stale manifest fails both.
   Upload the re-encrypted object and its updated manifest together,
   and verify the pair (download → sha256sum → compare) per archive
   before moving on. **Record the file id of every object this step
   uploads** (the upload response carries it) — step 6's straggler
   sweep needs the set to tell your own re-uploads apart from a
   genuine late Worker write.
4. `wrangler secret put BACKUP_ENCRYPTION_KEY` on
   `vaipakam-offchain-data-archive` to flip the Worker to the new key.
5. Wait for one full nightly cycle + one weekly healthcheck. Both
   should land green on the new key.
6. **Sweep for stragglers before retiring anything**: list every
   object uploaded between the step-1 pause time and the step-4 key
   switch (the `--long` listing carries upload timestamps), then
   **subtract the file ids step 3 recorded** — step 3's own
   re-uploads land in exactly this window, so without the exclusion
   every rotation "finds" its own writes and an operator trying to
   old-key-decrypt them gets GCM authentication failures on new-key
   ciphertext (#1450 r32). For anything REMAINING after the exclusion
   (a manual trigger, a pause that did not take), **key
   classification applies to `archives*` objects ONLY — manifests are
   plaintext JSON and fail decryption under every key by
   construction** (#1450 r33). A late Worker write leaves a PAIR in
   the residue: old-key-decrypt the archive half to confirm it, then
   send it through step 3, which regenerates its manifest as part of
   the same pass; the residual manifest needs reading, not
   decrypting. Only an `archives*` object that NEITHER key decrypts
   is an incident rather than a rotation artifact. Only then retire the OLD key —
   destroy the offline copies. Keep ONE
   archived offline copy in case of a B2 lifecycle anomaly that
   surfaces an old-cipher version mid-cycle.

The rotation window has TWO keys live at once. Treat that window as
a security-sensitive interval; don't merge anything to main during
it.
