# Off-chain data restore runbook

When you read this, something has gone wrong with the Cloudflare side
of Vaipakam — the account is locked out, the data is tampered with,
or a deploy mistake wiped a D1 table. This runbook walks the recovery
path back to a known-good off-chain state from a Backblaze B2 archive
produced by [`ops/offchain-data-warm`](../../ops/offchain-data-warm/README.md).

> **On-chain state is fine.** The Diamond, the VPFI token, and every
> position-NFT live on chain. The protocol's economic core is
> unaffected by anything in this document — what we're restoring is
> the off-chain convenience layer.

> **"ARCHIVE" MEANS THE BACKUP HERE — never the database called
> `vaipakam-archive`** (#2267). That word is overloaded as of the
> 2026-09-21 cutover and this is the one place it must not be misread.
>
> - **The archive** / `d1.archive[]` / "the archive's `schema[]`" — the
>   B2 tarball this runbook restores FROM. Every such use below means
>   the backup.
> - **`vaipakam-archive`** — a RETIRED D1 database, the predecessor of
>   the live one. It is retained for rollback and holds data frozen at
>   the cutover. **It is not a restore source and it is not a restore
>   target**, and a restore aimed at it writes to a database nothing
>   reads.
>
> The live shared database is **`vaipakam-warm`**, which is why every
> `wrangler d1` command below names it. If you are reading this during
> the cutover window itself — the writers stopped, the rows not yet
> carried — the live data is still in `vaipakam-archive` and this
> runbook does not cover that state; see
> [`D1CutoverArchiveToWarm.md`](D1CutoverArchiveToWarm.md) before
> restoring anything.

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
   wrangler d1 create vaipakam-warm
   wrangler d1 create vaipakam-keeper-db
   ```

   `vaipakam-keeper-db` is the keeper's PRIVATE database (#2450): its scan
   cursors, completion markers, remit-ack log, HF-band edge state, the
   Diamond each chain's state belongs to (`keeper_deployment`), the passes'
   open-work queue and its discovery cursor (`keeper_work_open`,
   `keeper_work_cursor`; both empty, the passes re-discover from the active
   Diamond's deploy block and drop each finished item after one on-chain read
   — never empty one without the other), the claim-horizon heartbeat's
   queue and cursor (`keeper_horizon_entry`, `keeper_horizon_cursor`; both
   empty, the heartbeat re-discovers from entry id 1 and loses only its
   stuck-clock and overdue history — again never one without the
   other) and the cutover's completion record,
   which nothing else reads. **The archive does not carry
   it** — the backup Worker binds only the shared database — so after a
   restore it starts EMPTY, exactly as these tables always did (none was
   ever archived; their restore treatment is #1481). Expect the keeper to
   rescan its remit-ack and commitment frontiers from the start, re-send an
   acknowledgement for each reservation still Pending on Base (paid CCIP
   messages, rate-limited per reservation from then on), and re-mint one
   HF-band inbox row per currently-degraded loan. The cutover record is not needed: the
   restored shared copies of the moved tables are empty, and the deploy asks
   for the record only while they hold rows.

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

   - `apps/indexer/wrangler.jsonc`     → vaipakam-warm
   - `apps/keeper/wrangler.jsonc`      → vaipakam-warm (`DB`) **and**
     vaipakam-keeper-db (`KEEPER_DB`)
   - `apps/agent/wrangler.jsonc`       → vaipakam-warm
   - `ops/offchain-data-warm/wrangler.jsonc` → vaipakam-warm

   The keeper's private database is pinned by id in one more place, like
   the shared one below: `PRIVATE_DATABASES` in
   `apps/indexer/scripts/lib/d1-workers.mjs`. Set its `id` to the new
   `vaipakam-keeper-db` uuid too — `check-d1-name-consistency` refuses a
   tree whose `KEEPER_DB` binding and that pin disagree, and the live-binding
   gate checks the serving keeper against the pinned id.

   **And one place that is not a `wrangler.jsonc`** (#2267): the cutover
   tooling pins the database by **id** as well as name, in
   `apps/indexer/scripts/lib/cutover-databases.mjs`. A fresh account gives
   `vaipakam-warm` a NEW uuid, so `SUCCESSOR.id` there is left pointing at
   a database that no longer exists — and because the Workers come up fine
   from their own configs, nothing fails until later: the live-binding gate
   expects the dead uuid, `check-d1-name-consistency` rejects the restored
   tree, and the carry and digest tools address a database that is not in
   this account.

   Set `SUCCESSOR.id` to the new uuid, and **leave the module in place.**

   **`PREDECESSOR` in that file is a different matter** — `vaipakam-archive`
   is not restored by this runbook and will not exist in the new account,
   so the cutover tooling has no second endpoint and is not usable there.
   That is correct: there is nothing to cut over to or roll back from
   after a full-account restore. The tools will refuse, by name, which is
   the right behaviour.

   **Do not delete the module** (#2267 r32). It is not a leaf:
   `check-d1-name-consistency.mjs` reads it unconditionally through its
   `COMMAND_GENERATORS` registry, and `apps/indexer/test/d1Reconcile.test.ts`
   imports one of its callers — so removing it and its two callers breaks
   the repository's own checks on a day when you are already restoring
   from backup. Retiring it properly means the registry entry, the tests,
   the package check wiring and the runbooks that reference it, which is
   a deliberate piece of work and not a restore step.

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
   >   `ops/offchain-data-warm` AND `apps/agent` (steps 6d and 6e below,
   >   which otherwise re-upload the saved token verbatim) AND the keeper
   >   machine, whose sanctions-hold pass posts operator alerts with it
   >   (#2450): replace the `TG_OPS_BOT_TOKEN=` line in
   >   `/etc/vaipakam/keeper.env` (`sudo -e`, never pasting the value
   >   elsewhere), then `sudo systemctl try-restart vaipakam-keeper` and check a
   >   tick logs no `ops alert … failed`. A surviving machine otherwise keeps
   >   the revoked token and every operator alert fails. `TG_OPS_CHAT_ID`
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
   >   are about to go looking for (#1450 r28).
   >
   >   **ENUMERATE THE KEYS FIRST — there is more than one write key, and
   >   "the two replacement keys" is not the whole job while #1977 is
   >   open.** `vaipakam-offchain-data-archive`, the un-retired predecessor
   >   Worker, holds its OWN `writeFiles` key and its own copy of
   >   `BACKUP_ENCRYPTION_KEY`. Rotating only the warm Worker's pair leaves
   >   that key valid, so the attacker can keep uploading new archive
   >   versions **after the procedure believes the window is closed** —
   >   which is the one outcome this step exists to prevent. List every
   >   application key on the account (`b2 key list`, or the console's App
   >   Keys page) and account for each one before you delete anything;
   >   `docs/ops/CloudflareCronSlots.md` names which Workers exist, and
   >   #1977 tracks the retirement that will make this a single pair again.
   >
   >   Then create replacement scoped keys **only for Workers running in the
   >   NEW account** — the same capability sets (write-only: `listBuckets` +
   >   `writeFiles`; read-only: `listBuckets` + `listFiles` + `readFiles`) —
   >   and delete **every** old key you enumerated.
   >
   >   **`vaipakam-offchain-data-archive` gets NO replacement key in this
   >   branch.** Revoke its key and stop. It has no source in this
   >   repository, so it can only be running in the account you are
   >   escaping — and issuing it fresh `writeFiles` credentials puts a
   >   working write key inside the compromised account, where the same
   >   attacker who took Workers Edit can read it and resume poisoning the
   >   archive bucket the moment you finish revoking the old one. That
   >   defeats the rotate-first containment this whole step exists for.
   >
   >   An earlier revision of this line said its replacement was "needed
   >   only if that Worker is still running", which reads as a condition to
   >   evaluate and answers YES on the compromise branch — the one branch
   >   where the answer must be no. Deploy credentials only to Workers in
   >   the fresh account (Codex #1978 r28). Leave
   >   the bucket's lifecycle rules untouched. Then
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

   d. `ops/offchain-data-warm` does NOT use the Secrets Store; its nine
      secrets are per-Worker `wrangler secret put`. Those are **not**
      validated at deploy, so skipping them lets the Worker deploy green
      and then fail at 03:17 UTC — silently, which is the exact failure
      mode the nightly exists to prevent. Set them before step 8:

      The first seven are HARD-REQUIRED — `assertRequiredEnv()` in
      `ops/offchain-data-warm/src/index.ts` aborts every scheduled
      invocation if any is missing, so omitting one produces a Worker that
      deploys green and then never backs anything up. The two `TG_OPS_*`
      values are optional (their absence downgrades to a console warn):

      ```bash
      ( cd ops/offchain-data-warm
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
      `apps/keeper/wrangler.jsonc` used to describe them as
      "operator-managed vars (non-secret config — plain `vars`)" while its
      committed `vars` block carried only `TG_BOT_USERNAME`. **That mattered
      for capture, not just for tidiness** — #2223 corrected it (closing
      #1465) and it now names them as secrets. Verified against the live
      deployment (2026-07-30): `KEEPER_ENABLED` is a per-Worker
      **`secret_text`** binding, and §7a step 3 restores it with
      `wrangler secret put` accordingly.
      The consequence here: a `secret_text` value **cannot be read back**,
      from the API or the dashboard. So capturing these offline is not
      optional convenience — it is the only record that will exist, and an
      operator who assumes they can be re-read later will find they cannot:

      | Flag | While unset | Arms |
      |---|---|---|
      | `KEEPER_ENABLED` | `isKeeperEnabled()` is false | autonomous liquidation, the matcher, liquidity-confidence submits, auto-lifecycle — and it gates the `REWARD_*` and `GRACE_DEFAULT_ENABLED` flags below as well |
      | `REWARD_REMIT_ENABLED` | remit + remit-ACK passes skip | reward-budget remittance and delivered-backing acknowledgement |
      | `REWARD_COMMIT_ENABLED` | commitment-report pass skips | mirror→canonical commitment reporting |
      | `GRACE_DEFAULT_ENABLED` | grace-default pass skips — past-grace loans stay Active until someone else closes them | autonomous `triggerDefault` on past-grace loans (#2483) |
      | `REWARD_DELIVERY_PROOF_ENABLED` | delivery pass skips — epoch days stay unindexed (their value funds nothing a claim can find) and an armed delivery gate holds every funded day | indexing every mirror delivery's epoch days and proving no-epoch day lists (#1944) |
      | `REWARD_SANCTIONS_KEEPER_ENABLED` | sanctions-hold observer skips — a held reward claimant goes unobserved, so its hold (and the custody-activation block it carries) can run past its window | observing held claimants, the owner settlement and resolving their held staging records (#2450) |
      | `REWARD_DAY_CLOSE_ENABLED` | day-close pass skips — no reward day is reported, finalized or broadcast unless someone makes those calls by hand, so the remit pass has no finalized day to fund and mirror users cannot claim | closing each elapsed reward day on every chain, finalizing it on Base and broadcasting it to the mirrors (#2612) |
      | `DISCOUNT_PATH_CHAIN_IDS` | the flash-loan discount branch skips on every chain; the partial / split / atomic branches still run | the discounted, flash-loan-funded liquidation on each chain it names that also has a FlashLoanLiquidator (none today; #2633, sizing #2697). A chain list, not `true`; ships empty |
      | `REWARD_HORIZON_HEARTBEAT_ENABLED` | horizon heartbeat skips — no reward's claim-horizon clock is observed, so an armed horizon expires nothing and files no final notice (the safe direction: nothing is reaped) | touching every live reward entry about every 12 hours so its executable-time clock advances (#2517) |

      The keeper's ops alert channel, `TG_OPS_BOT_TOKEN` + `TG_OPS_CHAT_ID`, is
      captured the same way: while unset the observer's operator alerts reach
      only the log.

      Capture their **values** in the same offline record as the
      credentials — they are operator state that nothing else preserves.
      Any optional tuning knobs actually in use (`REWARD_REMIT_LOOKBACK_DAYS`,
      `REWARD_REMIT_LANE_CAP`, `REWARD_COMMIT_LOOKBACK_DAYS`, the `LIQ_*` /
      `SPLIT_*` / `PARTIAL_LIQ_*` set) belong in that record too; unlike the
      four above, those have safe defaults, so an omission degrades tuning
      rather than turning a duty off.

      **Do NOT set them here.** They arm signing against a database §§4–6
      have not restored: a matcher or liquidator pass reading half-imported
      state would submit real transactions from a real key. Re-arming is
      §7a, after the smoke test, and is deliberately the last thing that
      happens before the backup writer.

7. Apply migrations — the shared schema from `apps/indexer`, and the
   keeper's private schema from `apps/keeper` (#2450). The keeper's
   `deploy` would apply the second itself; it is applied here so the
   restore order stays explicit.

   ```bash
   ( cd apps/indexer    && wrangler d1 migrations apply vaipakam-warm --remote )
   ( cd apps/keeper     && wrangler d1 migrations apply vaipakam-keeper-db --remote )
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
   > `agent.vaipakam.com`, `app.vaipakam.com`, the apex and `www` in **§7
   > step 4**, which exists for exactly this ("update DNS / frontend env
   > vars to point at the new Worker subdomains") and sits after the smoke
   > test. Having to activate the zone early for the indexer's sake is not a
   > reason to bind the rest early too.

   Every OTHER Worker is the opposite shape: it declares no route, so its
   hostname must be bound by hand in the dashboard after deploy. That
   includes both public surfaces — `apps/app` and `apps/www` are
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
   pre-cutover build and check, and switch `apps/app/.env.local` to
   the real hostnames as part of the §7 cutover. Leaving the zone inactive
   without staging those temporary origins is the failure in the other
   direction: the smoke test then has nothing to reach.

   The inventory, for §7 step 4:

   - `agent.vaipakam.com` → `vaipakam-agent`
   - `app.vaipakam.com` → `vaipakam-app`
   - `vaipakam.com` (apex — the canonical, indexable hostname) →
     `vaipakam-www`. `labs.vaipakam.com` → `vaipakam-www` only if the
     legacy hostname is wanted BACK: as of 2026-08-27 it is retired —
     no binding and no DNS record — so restoring it is a decision to
     revive a dead hostname, not part of returning to the status quo.
   - `indexer.vaipakam.com` → `vaipakam-indexer`, but **do NOT create
     this binding by hand.** `apps/indexer/wrangler.jsonc` declares it
     with `custom_domain: true`, so deploying that Worker creates it.
     It is listed here so its absence from the inventory is not read as
     an omission.
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

   > **Deploy them with their SCHEDULES OFF.** `apps/indexer` and
   > `apps/agent` declare `"crons": ["* * * * *"]`, so a
   > plain `wrangler deploy` here arms every-minute scheduled work against a
   > database that §§4–6 have not restored or verified yet. **The keeper is
   > the exception and needs no action:** it commits `"crons": []` — first
   > under #1896, and for good since #2569 moved the keeper onto its own
   > machine — so deploying it arms nothing; do not "fix" that empty list
   > here, and do not read the resulting quiet as a successful restore.
   > Concretely: the
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
   > For the **indexer and the agent** — not the keeper, whose empty list
   > is permanent (#2569) — set the
   > trigger list empty for this deploy —
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
   > the end of §6 (once its cursor is reset), and the **agent's** in §7a
   > after the smoke test. Do not simply revert the config now — the point
   > is that the schedules stay off until each one's data is verified.
   >
   > **The keeper is NOT in that restore, and this is the sentence most
   > likely to be skimmed.** Its Worker has no schedule to put back: since
   > #2569 the keeper runs only on the always-on machine
   > (`docs/ops/KeeperMachine.md`), its `wrangler.jsonc` keeps
   > `"crons": []` for good, and the Worker's `scheduled` handler declines
   > every tick it is given. Re-arming a Worker schedule here would spend a
   > trigger slot on a runner that does nothing — or, on an older build,
   > start an every-minute pass on a Worker holding a transaction-signing
   > key. The keeper comes back on its machine in §7a step 3, which covers
   > this deliberately; do not treat it like the agent.

   > **DO NOT deploy `ops/offchain-data-warm` yet.** Deploy it LAST,
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
   > and `apps/app/.env.local` still carries the OLD account's
   > hosts. So an `app` bundle built here calls hosts that no longer
   > answer, and editing the env afterwards changes nothing until it is
   > rebuilt. `apps/agent` additionally needs an operator-created
   > custom-domain binding — its Wrangler config declares no route.
   >
   > Deploy the WORKERS here, then choose the new origins and create the
   > agent's custom domain, then update `apps/app/.env.local` and
   > **rebuild and redeploy `app` and `www`** before the smoke test.
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
     `apps/app/.env.local`.

   ONLY THEN build and deploy the frontends. Vite embeds those origins at
   BUILD time, so a bundle produced before this point calls the lost
   account's hosts and editing the env afterwards changes nothing:

   ```bash
   pnpm --filter @vaipakam/app run deploy
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

> ⚠️ **FIRST: set `B2_BUCKET`.** Every command in this section reads it,
> including the time-critical `--versions` listing in the compromise box
> below. Unset, it expands to an empty argument and the listing fails; in a
> reused shell it may still hold a stale value and list the wrong bucket.
>
> ```bash
> # Use the FIRST line. Uncomment the second only as the fallback described
> # below. Do NOT pick by "whichever lists your date" — both Workers are
> # scheduled, so that rule no longer discriminates. What each bucket
> # actually holds is established by the listing, never by this comment.
> B2_BUCKET=vaipakam-offchain-data-warm      # supported path — start here
> # B2_BUCKET=vaipakam-offchain-data-archive # fallback, and for older nights
> ```
>
> **The backup service was renamed and a bucket cannot be renamed**, so the
> replacement was created new and the old `vaipakam-offchain-data-archive`
> stays live until the replacement has completed a run.
>
> **Both Workers are still SCHEDULED, on the same minute** — verified
> against the account 2026-08-27 (#1977). The old Worker was never retired:
> it is armed on `17 3 * * *` exactly as the replacement is, with its own B2
> credentials and its own copy of `BACKUP_ENCRYPTION_KEY`.
>
> **Scheduled is not the same as uploaded.** The account check reads trigger
> configuration; it says nothing about whether a given night's object exists.
> A run can be armed and still produce nothing — the replacement's own
> preflight aborts the invocation when a secret is missing. So do not assume
> either bucket holds a particular night: **the listing is what establishes
> which archives exist**, and it is the only thing that does.
>
> What the account state does establish is that the old rule is dead. An
> earlier version of this box said "the two never both hold a given night, so
> whichever lists your date is the one to restore from"; with both Workers
> scheduled, that no longer discriminates, whatever each bucket turns out to
> contain.
>
> While both are armed. **The two SELECTION rules — prefer, and fall back —
> are for an ordinary restore only**; after a compromise use the box that
> follows this one, and read the carve-out under the fallback bullet first.
> The last two bullets apply on BOTH paths, and the credentials one applies
> most sharply on the compromise path — it is the bullet that tells you the
> next box is reasoning about one attacker-writable bucket when there are
> two. An earlier revision of this sentence disclaimed "the rules below" as
> a block, which voided that warning on the only path it was written for.
>
> - **Prefer `vaipakam-offchain-data-warm`** — the replacement is the
>   supported path, and its Worker is the one whose source is in this
>   repository (`ops/offchain-data-warm`). The old Worker's source is not
>   in the tree at all, so nothing here describes what it writes today.
> - **Fall back to `vaipakam-offchain-data-archive`** if the warm bucket
>   does not list your date **or lists it and the object fails
>   verification** — checksum, length or decryption. Both are fallback
>   conditions, and both are findings for the incident record. An earlier
>   revision allowed only the missing-listing case, which would have sent a
>   restore backwards through the warm bucket's older nights while an
>   independently written copy of the night you actually want sat in the
>   other bucket — **if one was written**. Both Workers being scheduled is
>   why such a copy *may* exist; it is not evidence that it does, and this
>   sentence previously said it was. **List the archive bucket for your date
>   and verify the object before treating this as a fallback at all**: a
>   run can be armed and still upload nothing, which the box above states
>   and this bullet contradicted. If the archive bucket does not list your
>   date either, you have two failed sources and an incident finding, not a
>   fallback.
>
>   **After a compromise, this trigger is suspended — but the other bucket is
>   not off-limits.** The distinction is what you are reacting to:
>
>   - **A verification failure is NOT a reason to reach for the other
>     bucket.** That is the reflex the next box exists to forbid, wearing a
>     different hat: the old Worker holds a `writeFiles` key and its own copy
>     of `BACKUP_ENCRYPTION_KEY`, so an object it serves can verify perfectly
>     and still be theirs. "This one failed, try the other" selects on
>     verifiability, and verification proves integrity, not provenance.
>   - **A copy whose OWN version timestamp predates the compromise window is
>     a legitimate candidate, from either bucket.** That is not the reflex —
>     it is the next box's step 2 applied to a second set of versions, and
>     the rule there is already "every object uploaded at or after the
>     boundary is attacker-controlled", which says nothing about which bucket
>     it sits in. Capture its file ID from a `--versions` listing and
>     download by ID, exactly as you would in the warm bucket.
>
>   So: a corrupt pre-window warm object does not force you backwards through
>   older nights if the archive bucket independently wrote that same night and
>   that copy is itself pre-window. Refusing it would trade a night of data
>   for no security gain — the object is admissible on the *same* test the
>   warm one passed. An earlier revision of this carve-out forbade the other
>   bucket outright, which read the "suspend the fallback" rule as "the other
>   bucket is untrusted"; those are different claims, and only the first is
>   true.
>
>   This carve-out was missing when the verification-failure condition was
>   first added, and the omission has a shape worth naming: the fallback was
>   written against the ordinary path, where the other bucket is a spare
>   copy, and never re-read against the adversarial path three paragraphs
>   below, where the same bucket is an attacker's write target. One
>   sentence, two paths, opposite meanings.
> - **An empty listing in ONE bucket is still not "no backups exist"** —
>   that part stands. Re-run against the other before concluding anything.
> - The compromise reasoning further down assumes ONE holder of a
>   `writeFiles` B2 key and one copy of the encryption key. **There are
>   two.** Treat the old Worker's credentials as in scope for any
>   rotation.
>
> Delete this box once the old bucket is retired: at that point there is one
> answer, and offering a choice becomes a hazard of its own.

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
> 0. **There are TWO write-capable buckets, not one**, while #1977 is open —
>    see the box above. Steps 1, 2 and 4 apply to both: two `writeFiles` keys
>    to rotate, one compromise window governing both, and two sets of
>    versions to list — a forgery can sit in either.
>
>    Two things here do **not** simply double, and assuming they do is the
>    trap:
>
>    - **Step 5's retention numbers describe the WARM bucket only.** They
>      were read off `vaipakam-offchain-data-warm`; the old Worker's source
>      is not in this repository, and nothing here has ever established the
>      archive bucket's lifecycle rules. Its version-retention reach is
>      **unknown** — read it off that bucket with `b2_list_buckets` before
>      relying on a pre-window version having survived there, and do not
>      carry the ~29-day daily figure across. A bucket nobody configured
>      from this tree may retain for a day.
>    - **The ordinary-restore fallback is SUSPENDED, not doubled** — that is
>      the box above's carve-out, and the one rule here that inverts rather
>      than widening.
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
>    - **Object Lock is not enabled** on `vaipakam-offchain-data-warm`
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
>      b2 ls "$B2_BUCKET" --recursive --long --versions "$p"
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
b2 ls "$B2_BUCKET" --recursive --long manifests/ \
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
  "b2://${B2_BUCKET}/${MANIFEST_KEY}" \
  ./restore/manifest.json
b2 file download \
  "b2://${B2_BUCKET}/${ARCHIVE_KEY}" \
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
vaipakam-offchain-data-warm`.

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

**Critical**: `d1.archive[]` entries go to `vaipakam-warm`. Restoring
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
   ( cd ops/offchain-data-warm && \
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

   **`vaipakam-warm` tables** (born-off-chain): `diag_errors`,
   `diag_legal_holds`, `diag_legal_hold_audit`, `user_thresholds`,
   `notify_state`, `pre_grace_notify_state` (absent from pre-#1480
   archives), `telegram_links`, `support_tickets`,
   `recycle_day_backfill` (absent from pre-#1349-M5 archives),
   `loan_orphans` (absent from pre-#2197 archives).

   > **`loan_orphans` is restored, not replayed** (#2197, #2636). It holds
   > `loans` rows the indexer proved the chain has no loan for, each moved
   > out of publication with the whole row kept in `row_json` and the
   > loan's ledger, participation and notification rows kept in
   > `related_json`. The replay
   > cannot recreate one: the row came from something canonical history
   > does not contain (an initiation from a block later reorganised away),
   > so the archive is the only record of what the platform published and
   > withdrew. Nothing reads the table on any public surface; it is the
   > operator's record, and the indexer's stale report names every entry not
   > yet marked reviewed (`reviewed_at`), so a restored database keeps
   > naming the withdrawals nobody has looked at. If the replay re-indexes a loan that is also listed here, the
   > chain has that loan after all: the `loans` row is correct, and the
   > `loan_orphans` entry is a record of the earlier withdrawal, nothing
   > more.

   > **`recycle_day_backfill` is the one recycling table that is restored
   > rather than replayed**, and the distinction is load-bearing. Almost
   > every other `recycle_*` table is a fold of chain logs, so §6's replay
   > rebuilds it exactly — those are in the clear-before-replay command
   > and must NOT be imported here.
   >
   > **`recycle_backing_snapshot` is a second exception, in the opposite
   > direction** (#1525). It is cleared like the replayed tables, but the
   > replay does NOT rebuild it: it holds a periodic reading of LIVE
   > contract state, written only by the scheduled capture pass, so it
   > stays empty until that pass next runs — within one round-robin cycle
   > of restore. Do not wait for it during the replay and do not verify it
   > as replay output; an empty table there is the expected state, and the
   > dashboard withholds the backing block rather than publishing zeros.
   > It is deliberately NOT imported from the archive either: a restored
   > copy would republish an old backing verdict as a current one.
   >
   > **Back to `recycle_day_backfill`** — the table this section is about,
   > and the one that IS imported here. It holds pre-cutover day figures
   > recomputed from `getRecycleDayMetrics`, whose `dayCapThreshold18`
   > input `setBroadcastDayCapThreshold` can overwrite for an
   > already-finalized day on a demoted Diamond. After that, re-running
   > the backfill yields DIFFERENT numbers and the original is
   > unrecoverable — those days carry no widened event to fall back on.
   > Restoring it is the only way to keep published history intact; a
   > re-run is not a substitute.

   ```bash
   wrangler d1 execute vaipakam-warm --file=restore/d1/<table>.sql --remote
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
`ops/offchain-data-warm/scripts/restore-from-archive.mjs` (#1477 —
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
`oracle_snapshot_state`, `liquidity_confidence`, `indexer_cursor`,
`prenotify_scan_cursor`, `indexer_deployment`),
the design doc favours **re-indexing from block 0** over restoring
from the archive. Why:

- Re-indexing produces the canonically-correct state from chain logs.
  The archive could be days old — re-indexing catches up to head.
- The archive could itself be subtly wrong (silent corruption,
  pre-image of a tampered DB). Re-indexing is the integrity-checking
  restore path.

```bash
# FIRST, the keeper's PRIVATE database (#2450): the HF-band state is
# producer state for the inbox rows the shared command below clears, and
# it lives in vaipakam-keeper-db now, not in the shared database. Run it
# BEFORE the shared command — see "notifications is cleared with its
# producer state" below for why the order matters.
( cd apps/keeper && wrangler d1 execute vaipakam-keeper-db --remote --command="DELETE FROM hf_band_state" )
```

```bash
# Clear EVERY replay-derived table, then the cursor, so the replay
# starts from genesis into empty tables.
wrangler d1 execute vaipakam-warm --remote --command="\
DELETE FROM activity_events; \
DELETE FROM loan_participants; \
DELETE FROM notifications; \
DELETE FROM swap_to_repay_intents; \
DELETE FROM loan_reconcile_quarantine; \
DELETE FROM loans; \
DELETE FROM offers; \
DELETE FROM oracle_snapshot_state; \
DELETE FROM liquidity_confidence; \
DELETE FROM recycle_day_pool; \
DELETE FROM recycle_series_events; \
DELETE FROM recycle_series_state; \
DELETE FROM recycle_prelaunch; \
DELETE FROM recycle_chain_reported; \
DELETE FROM recycle_backing_snapshot; \
DELETE FROM prenotify_scan_cursor; \
DELETE FROM push_rail_status; \
DELETE FROM indexer_deployment; \
DELETE FROM indexer_cursor"
```

`indexer_deployment` (#1566, Codex #2545 r1) records, per chain, the Diamond
the rows were indexed from; the replay's first pass re-adopts the bundle's
Diamond and — with the row gone — resets nothing, which is right: the tables
above are already empty. Leaving it would be wrong only in the other
direction (a row naming a Diamond the bundle no longer does would trigger a
reset of tables the replay is already filling).

`push_rail_status` (#2667) is not chain data either: it is the keeper's
Push rail readiness, which the keeper republishes on every watcher run.
Clearing it costs at most a minute of the agent's `GET /push/status`
answering for its own rail alone. Keeping it would let a restored row vouch for a
configuration the keeper may no longer have.

`prenotify_scan_cursor` (#2219) is a watermark like `indexer_cursor`,
not data: it records the DEADLINE at which the pre-notify scan resumes.
Clearing it restarts that scan at the nearest deadline, which prefers
duplicated work to stepping over a nearer one — the direction this
failure must take. That is a property of the restarted run, not a
guarantee about the reminders: if the lane has more due loans than one
run can examine, a run restarting at the front spends its allowance on
the prefix, and a loan in the tail close to its own deadline can leave
the notification window before a later run reaches it. The single
statement of what a pass does and does not promise is in
`docs/FunctionalSpecs/Alpha02ConnectedApp.md` under the reminder-run
bullets; this note does not restate it.

Leaving the row would be worse than clearing it: it would point the lane
at a deadline from a database the replay is in the middle of rebuilding.

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
replay as a visible user action. #1450 r31/r32.
`loan_reconcile_quarantine` likewise, and it fails in the more
alarming direction: each row says "do not act on this loan, we could
not confirm it", so a fabricated entry is a silent suppression — it
withholds a real borrower's due-date and grace reminders with nothing
on any surface to show why. The reconciliation pass rewrites the
table from the chain as it examines rows, so clearing it costs at
most one rotation's worth of re-marking. #2212.
`loan_orphans` is deliberately NOT in this command: the replay cannot
recreate a withdrawn row, so it is restored from the archive in §4
instead. #2197.)

**`notifications` is cleared with its producer state, and the loss
boundary is stated honestly** (#1450 r33). The table has THREE
producer classes, and "the replay regenerates it" is true of only
one: chain-event rows come back from the block-zero replay; the
keeper's HF-band rows come back only as *current-state* rows, and
only because `hf_band_state` is cleared in the same step — with
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

**Two databases, so two commands, and the ORDER is the safeguard**
(#2450). `hf_band_state` is keeper-private now and lives in
`vaipakam-keeper-db`; D1 cannot clear tables in two databases in one
command, so the pair is no longer atomic. Clear the private state FIRST,
as the fences above do. If the shared command then fails, the state is
empty while the inbox rows remain — the keeper's next tick re-derives one
row per degraded loan and the day-bucket dedup absorbs it, the benign
direction. The reverse order, interrupted, leaves exactly the worst
combination above. Re-run whichever command did not complete before
moving on.

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

Everything up to here has run with `apps/agent` deployed but never
scheduled (§1 step 9), and with no keeper running anywhere. This is where
that ends. The order below is the point of the section: it moves from passes
that only read, to passes that message users, to passes that sign
transactions — so a mistake is caught at the cheapest stage. The keeper is
restored on its machine in step 3; its Worker keeps `"crons": []` for good
(#2569).

1. **Restore the AGENT's schedule and redeploy** — not the keeper's; see the
   note below, and step 3 for the keeper. (This step said "both schedules"
   until #1450 r26, contradicting its own body and the note inside it.) Put
   `"triggers": { "crons": ["* * * * *"] }` back in
   `apps/agent/wrangler.jsonc` and deploy the **agent** — its notification
   and retention passes read and message only. Expect the first tick within
   a minute.

   > **The keeper's tick is NOT read-only, so the keeper is not started
   > here.** `runDailyOracleSnapshot` checks only that `KEEPER_PRIVATE_KEY`
   > is present and then calls `writeContract` — it does **not** consult
   > `KEEPER_ENABLED`. Starting the keeper therefore arms a
   > transaction-signing pass immediately, from a key this restore has just
   > put back, before anything has verified the signing configuration. If
   > it starts during 00:00–00:09 UTC with no current-day
   > `oracle_snapshot_state` row, it broadcasts on the first tick. Treating
   > the keeper tick as "reads and alerts only" was wrong — that is true of
   > its *other* passes, not of this one. The keeper is started in step 3,
   > on its machine, together with the signing configuration that implies;
   > its Worker has no schedule to restore (#2569). Gating that pass behind
   > `isKeeperEnabled` like every other signing pass was tracked as #1466
   > and has been **declined** (owner decision 2026-08-03): the snapshot is
   > a public good rather than an autonomous risk-taking action — anyone may
   > call `captureDailyPriceSnapshot` permissionlessly — and gating it would
   > leave holes in the price series whenever the keeper is disabled for an
   > unrelated reason. So the behaviour above is permanent, not pending a
   > fix. To make a window genuinely write-free, stop the machine's service
   > (`KeeperMachine.md` §6).

2. **Watch one full agent tick before going further.**

   ```bash
   wrangler tail vaipakam-agent
   ```

   A first tick that throws on a missing table or an empty binding means
   something in §§4–6 did not land; fix that before arming anything that
   signs. The agent's notification passes send real user messages from
   this moment — if the restore is long enough that state has gone stale,
   expect a burst.

3. **Only then restore the keeper — on the machine, disarmed first, armed
   last**, from the offline record captured in §1 step 6f.

   > **Since #2569 the keeper's ticks run on the always-on machine**
   > ([`KeeperMachine.md`](KeeperMachine.md)), and the Worker's `scheduled`
   > handler declines every invocation it gets. So NOTHING in this restore
   > restores a keeper cron: `"crons": []` stays committed and deployed, and
   > the Worker is deployed at all only because its deploy is the private
   > database's one migration applier (`apps/keeper/scripts/deploy-keeper.mjs`).
   > Earlier revisions of this step carried a two-branch procedure (a #1896
   > hold, then a schedule restore with cron-slot bookkeeping, a propagation
   > window and `wrangler tail`); every one of those actions would now either
   > do nothing or spend a trigger slot on a Worker that declines the tick.
   > `CloudflareCronSlots.md` lists no keeper row and holds no reservation
   > for it (#2570); the restore leaves it that way and recreates nothing.

   Before anything: confirm the keeper EOA is the address you expect and is
   funded on every chain it submits from.

   **A. Deploy the Worker — as the applier, nothing more.**

   ```bash
   ( cd apps/keeper && pnpm run deploy )
   ```

   It applies `apps/keeper/migrations/` to `vaipakam-keeper-db` (§1 step 7
   may already have; the apply is idempotent), verifies every file is
   recorded, checks the cutover verdict — which PASSES on a restore without a
   record, because the restored shared copies of the five moved tables are
   empty (§1 step 3) — verifies the shared schema, and publishes with an
   empty schedule. The deploy token needs D1 Edit for that apply. Confirm no
   schedule was carried:

   ```bash
   # UNQUOTED heredoc delimiter — `<<'HDR'` would suppress expansion and send
   # curl the literal string `$CF_API_TOKEN` as the bearer token (#1450 r21).
   # `-K -` keeps the token out of the process's argv either way.
   read -rsp 'Cloudflare API token: ' CF_API_TOKEN; echo
   curl -sS --fail-with-body -X GET -K - <<HDR \
     "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/vaipakam-keeper/schedules" | jq '.result'
   header = "Authorization: Bearer $CF_API_TOKEN"
   HDR
   unset CF_API_TOKEN
   ```

   An **empty `result.schedules` ARRAY** is the pass condition (that endpoint
   always returns `result` as an object, `{"schedules": []}` when nothing is
   armed). A non-empty one means a schedule was restored by hand: the Worker
   declines each tick it gets, but a trigger slot is spent and a second
   runner is one config edit away — remove it from *Settings → Trigger
   Events*.

   The Worker's own `KEEPER_ENABLED`, `REWARD_*`, `GRACE_DEFAULT_ENABLED`
   and `KEEPER_PRIVATE_KEY` bindings drive NO pass any more. Leave them as §1
   step 6 restored them; they are not what step 4 confirms.

   **B. The machine, with every flag off — and pointed at the NEW account.**
   If the machine survived (a Cloudflare-side restore), `/etc/vaipakam/keeper.env`
   still holds the keeper's secrets, RPC URLs, knobs and flags. If it was
   rebuilt, install it per `KeeperMachine.md` §3 and fill the env file per §4
   from the offline record. Either way, BEFORE starting, set
   `KEEPER_ENABLED=false` and every per-pass flag (`REWARD_REMIT_ENABLED`,
   `REWARD_COMMIT_ENABLED`, `REWARD_DELIVERY_PROOF_ENABLED`,
   `GRACE_DEFAULT_ENABLED`, `REWARD_SANCTIONS_KEEPER_ENABLED`,
   `REWARD_HORIZON_HEARTBEAT_ENABLED`, `REWARD_DAY_CLOSE_ENABLED`,
   `DISCOUNT_PATH_CHAIN_IDS`) empty — by editing the
   file (`sudo -e /etc/vaipakam/keeper.env`), never by assuming what it held.
   Never paste a value from that file anywhere.

   The machine reaches BOTH databases over the D1 HTTP API, and a fresh
   account changes every coordinate it uses, in two places that a surviving
   machine still carries from the lost account:

   - **The env file's three D1 settings** name the shared database:
     `CLOUDFLARE_ACCOUNT_ID` (the new account), `D1_DATABASE_ID` (the new
     `vaipakam-warm` uuid from §1 step 3) and `CLOUDFLARE_D1_API_TOKEN` (a
     token minted in the new account with D1 Edit on both databases). Set all
     three in the same edit as the flags. A surviving machine still holds the
     old account's values, and the old token is dead with the account.
   - **The private database's id is NOT in the env file.** The build pins it
     from `PRIVATE_DATABASES` in `apps/indexer/scripts/lib/d1-workers.mjs`
     (`apps/keeper/host/hostEnv.ts` binds `KEEPER_DB` from that pin, never
     from a host setting), so the machine reaches the new `vaipakam-keeper-db`
     only once it runs a build carrying §1 step 5's recovery commit — the new
     pin, the wrangler ids and `SUCCESSOR.id`. The updater installs whatever
     branch `/opt/vaipakam-keeper/deploy-branch` names (`main` unless
     `KEEPER_DEPLOY_BRANCH` set another at install). Get that commit onto the
     installed branch BEFORE the service starts: merge it to `main` and run
     `sudo systemctl start vaipakam-keeper-update.service` once, or, while
     it is still under review, write its branch name to
     `/opt/vaipakam-keeper/deploy-branch` (on a rebuild, install with
     `KEEPER_DEPLOY_BRANCH=<recovery branch>`) and run the update service once;
     set it back to `main` after the merge. The update service reports the
     installed commit in its log — confirm it is the recovery one.

   A machine started with either place still pointing at the lost account
   does not fail loudly: the shared reads go to an account or database that
   no longer exists, and the private reads to a uuid that exists nowhere, so
   every tick declines, naming an unread migration record or an unread
   indexer record, for as long as it runs. Step C's first good tick is what
   confirms the retarget took; a decline that names an unread record after
   step A has applied the migrations means one of the two places above still
   carries the old account. A build that reads `KEEPER_DB` also declines
   every tick, naming the missing migration, until step A has applied it —
   that is the gate working, not a fault.

   **C. Start disarmed and validate** — `KeeperMachine.md` §5 step 1:

   ```bash
   sudo systemctl enable --now vaipakam-keeper
   journalctl -u vaipakam-keeper -f
   ```

   Count a tick as good only if its `[keeper] chains resolved: …` line names
   exactly the chains served, no pass logged an error, and there is no `tick
   declined`, skipped-minute or `not launched … still in flight` line. A
   tick that takes the lease logs `runner "host:…" acquired the one-runner
   lease`; one that renews its own lease prints nothing about it (KeeperMachine
   §6, "Apply an env-file change"). A `holds the one-runner lease` decline means another runner is live — stop and find
   it before anything else. Cover a full 15-minute cycle (`preGraceWatcher`)
   and the 00:00–00:09 UTC window (`dailyOracleSnapshot`); neither checks
   `KEEPER_ENABLED`, so both run disarmed — and the snapshot SIGNS, from the
   restored key, which is why the key and funding check above comes first.

   **D. Confirm the flags from a tick** — step 4 below, with
   `KEEPER_ENABLED` at `false` ON PURPOSE.

   **E. Arm — the earliest safe point, and only with the owner's OK** —
   `KeeperMachine.md` §5 steps 2–3. Set `KEEPER_ENABLED=true` in the env
   file, `sudo systemctl try-restart vaipakam-keeper`, and cover at least one
   full 5-minute cycle of the gated passes. Then the per-pass flags that were
   on per the offline record, ONE AT A TIME, each validated on its own
   cadence. Rollback at any point: `KEEPER_ENABLED=false` and restart, or
   `sudo systemctl stop vaipakam-keeper` (§6). Nothing on the Cloudflare side
   changes in either direction.

   `REWARD_REMIT_ENABLED` has two further prerequisites, and on a
   NON-compromise restore **both are normally already satisfied** — so
   VERIFY them rather than assuming they need rebuilding:

   - **The remit-ack tables.** They are keeper-private since #2450 and
     come from the keeper's own `apps/keeper/migrations/0001_keeper_state.sql`
     (the shared `0044_keeper_remit_ack.sql` still exists, and still applies
     to `vaipakam-warm`, but the keeper no longer reads that copy). §1 step 7
     and step A above apply the private one. Confirm it from `apps/keeper/`:
     `wrangler d1 migrations list vaipakam-keeper-db --remote`.
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

4. **Confirm the flags from a tick.** Nothing can read a flag's value back
   — on the Worker they were write-only secrets, and on the machine the env
   file is root-only and must never be echoed — so **the tick is the
   authoritative check**: since #1475 every gated pass emits exactly one
   line per tick naming its state, whichever way its gate goes.

   ```bash
   journalctl -u vaipakam-keeper -f
   # Wait for one tick.
   ```

   **One tick resolves every flag.** Every *gated* pass emits exactly one
   line per tick, and the skip line names each binding that stopped it:

   - Armed and running: `[keeper] <pass> start`.
   - Stopped: `[keeper] <pass> skipped: <BINDING> <what is wrong>`, one clause
     per blocker, separated by `; `. For example:

     ```
     [keeper] rewardBudgetRemit start
     [keeper] commitmentReport skipped: REWARD_COMMIT_ENABLED wrong case — these flags require lowercase `true`
     [keeper] remitAck skipped: KEEPER_ENABLED unset; KEEPER_PRIVATE_KEY unset
     ```

   **No value is ever printed — only the form of the state**: `unset`,
   `empty`, `off (explicitly disabled)`, `wrong case`,
   `has surrounding whitespace`, or `unrecognised (N chars)`. The signing
   key adds `malformed (N chars, expected 66)`, `malformed (not
   hexadecimal)` and `malformed (not a valid signing key)` — that last one is
   a value of the right length and alphabet that is still not a scalar on
   the curve, which only attempting to build the account can determine.
   Malformed is the one to expect during a restore: a key that is present
   but unusable used to satisfy the gate, so every pass announced `start`
   and then produced nothing. Echoing a value would copy a credential into
   the journal at the moment it is likeliest to be wrong, which is exactly
   how a pasted credential arrives; the character count still tells you
   whether you are looking at a four-letter typo or something long that does
   not belong there.

   `off (explicitly disabled)` is a STATE, not a fault: setting a flag to
   `false` is the documented way to disable a pass, and during step 3C–D
   every gated pass reports `KEEPER_ENABLED off (explicitly disabled)` ON
   PURPOSE. "Fixing" those lines arms the fund-moving passes before the
   disarmed validation has finished — leave `KEEPER_ENABLED` alone until
   step 3E. Every OTHER named blocker is worth repairing now.

   **Every blocker appears on the one line.** If three settings are wrong,
   one line names all three — you are never fixing one and waiting a tick to
   discover the next.

   The gated passes are every pass in `KEEPER_PASSES`
   (`apps/keeper/src/passSchedule.ts`) whose run calls `passIsArmed`. Today
   that is `matcher`, `liquidator`, `autoLifecycle`, `graceDefault`,
   `rewardBudgetRemit`, `remitAck`, `commitmentReport`, `deliveryProof` and
   `rewardSanctionsHold`.
   This list is the one place the set is written down; every other step here says "every
   gated pass" rather than counting them, because a count goes stale the day
   a pass is added (#2497 r1). `watcher`, `dailyOracleSnapshot` and
   `preGraceWatcher` have no binding of their own, and `liquidityConfidence`
   always runs and consults the gate only to decide whether to submit —
   **absent lines from those four are normal**, not a failed tick.

   **Repairing a named setting.** On the machine every flag, secret and knob
   is one line in `/etc/vaipakam/keeper.env`, read when the process starts:

   ```bash
   sudo -e /etc/vaipakam/keeper.env        # fix the named line; never paste the value elsewhere
   sudo systemctl try-restart vaipakam-keeper  # the tick in flight finishes first
   ```

   Then watch another tick. There is no `wrangler secret put` and no
   Secrets Store step here: those write the Worker's bindings, which drive no
   pass since #2569, so a repair made there looks successful and changes
   nothing a tick reports. (`KEEPER_PRIVATE_KEY unset` on the machine has one
   cause — the line is empty or missing — unlike the Worker, where a failed
   store lookup produced the same line for a tick.)

   Do not conclude the restore is complete until one tick has produced a
   line from **every gated pass** (the list above), and every line reads the
   way you intended. The other four emit nothing by design — waiting for
   them would be waiting forever.

   **The two guards do not parse alike**, which is a trap worth knowing
   before you eyeball the output:

   | | accepts | rejects |
   |---|---|---|
   | `KEEPER_ENABLED` (`isKeeperEnabled`) | `true` / `1`, **case-insensitive** — `True` and `TRUE` are on | anything else, **and** it returns false whenever `KEEPER_PRIVATE_KEY` is unset, regardless of the flag |
   | `REWARD_REMIT_ENABLED`, `REWARD_COMMIT_ENABLED`, `GRACE_DEFAULT_ENABLED` (`passIsArmed`) | exactly `true` or `1`, **case-SENSITIVE** | `True`, `TRUE`, and anything with surrounding whitespace |

   So `KEEPER_ENABLED=True` works while `REWARD_REMIT_ENABLED=True` is off —
   **off but reported**, not silently so. That is the whole point of the
   diagnostic above: the tick says `REWARD_REMIT_ENABLED wrong case — these
   flags require lowercase \`true\``, naming the asymmetry rather than
   leaving you to deduce it. (It WAS silent until #1475; if you are working
   from memory of the old behaviour, that is the change.) Use lowercase
   `true` for every flag and the asymmetry never arises.

   Only after that is the journal useful as positive confirmation: watch for
   a pass you expect to have work to do. Arming is step 3E, and its gate is
   the disarmed validation in 3C and this step; nothing printed here is a
   command to run before then.

   If `PUSH_CHANNEL_PK` was rotated, confirm a `[push] sent channel=…` line
   from the keeper too (`docs/ops/IncidentRunbook.md`, Push-rotation step 6).

---

## 7b. LAST: activate the backup writer

Only now — after §§4–5 have restored D1 and R2, and §7's smoke test says
the stack is real — deploy `ops/offchain-data-warm`:

```bash
( cd ops/offchain-data-warm && npm ci && npm run deploy )
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
wrangler tail vaipakam-offchain-data-warm
# Trigger the cron manually from the CF dashboard's "Trigger" button.
```

The run should produce a fresh archive plus a green Telegram alert. It is
safe to trigger here precisely because §§4–5 have already restored the
data — the archive it writes is of the RESTORED account, not an empty one.

### Finally, reconcile the cron-slot authority

§6 makes the authority's keeper edit but explicitly defers the
account-versus-file confirmation. This is where it lands, and the ordering is
load-bearing: `--live` compares every row the file calls live against the
schedules the account actually holds, and `vaipakam-offchain-data-warm` only
acquires its trigger at the `npm run deploy` above. Run earlier — as an
in-between revision of this runbook did (Codex #1978 r37) — and the warm Worker
is committed-but-not-live, so the check exits non-zero on the restore's own
incompleteness and reads as a failure of the thing it is confirming.

Skip it and a successful restore ends with
[`CloudflareCronSlots.md`](CloudflareCronSlots.md) still listing a live
`vaipakam-offchain-data-archive` that exists only in the abandoned account —
the authority then over-states occupancy and misdirects the next deploy, which
is #1977 again by a different route.

1. Remove the `vaipakam-offchain-data-archive` row: on the fresh account that
   Worker does not exist, and it has no source in this repository to restore
   it from.
2. Re-derive **all three summary lines** — "Live right now", the `Committed`
   label, **and "Genuinely spare"** — from the rows that remain, and refresh
   the `Verified:` stamp.

   **The spare line is the one this step used to omit, and omitting it fails
   the very next command** (Codex #1978 r42). Dropping the archive row
   lowers committed by one, so spare must rise by one; `checkSummary`
   derives spare as `5 − committed` and rejects the stale value, so step
   3's `--live` exits non-zero and the reconciliation cannot complete. The three lines are one
   derivation and have to be re-done together — which is exactly what the
   authority says about itself, in the sentence explaining why the summary is
   pinned to the table.
3. Re-read the token first. §7a step 3A runs `unset CF_API_TOKEN` at the end
   of its empty-schedule readback, which is far above this point, so following
   the runbook in order arrives here with the variable GONE — under the
   `set -u` these blocks use that aborts, and without it `--live` receives an
   empty credential and reports missing credentials. Either way the operator
   reads a failure of the gate rather than the reconciliation it was asked for
   (Codex #1978 r40).

   ```bash
   read -rsp 'Cloudflare API token: ' CF_API_TOKEN; echo
   CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
     node .github/scripts/check-cron-slots.mjs --live
   unset CF_API_TOKEN
   ```

   The token goes to the gate through the ENVIRONMENT, which is
   `/proc/<pid>/environ` and readable only by its owner — unlike argv. That is
   why this one does not need the `curl -K -` form the HTTP reads above use.
   `unset` afterwards, per the same rule.

   Now that the account is complete, this is the check that was impossible
   earlier.
4. **Commit it.** An uncommitted reconciliation leaves the branch carrying the
   old-account inventory, which is the staleness the whole exercise removes.

Confirm one clean nightly before considering the restore complete — the
first successful unattended run is the evidence that the whole pipeline,
not just the Worker, came back.

## 8. Key-rotation procedure for `BACKUP_ENCRYPTION_KEY`

Not part of an emergency restore, but documented here because the
two procedures share the offline-key handling discipline.

> ⚠️ **WHILE #1977 IS OPEN, THIS PROCEDURE IS WRITTEN FOR THE WRONG
> NUMBER OF WORKERS.** It says "the archive Worker" and flips one secret;
> there are **two** Workers scheduled, each holding its **own copy of
> `BACKUP_ENCRYPTION_KEY`** and writing to its **own bucket** — see §2's
> selection box and `docs/ops/CloudflareCronSlots.md`.
>
> Run as written, it pauses one Worker, migrates one bucket, flips one
> secret, and then **destroys the old key at step 6**. The Worker that was
> not migrated keeps producing OLD-key ciphertext throughout, and the
> predecessor bucket's entire retained history becomes **permanently
> undecryptable** — including the copies §2 now names as a restore
> fallback. That is the same failure step 1 already guards against for a
> single Worker's late write, at the scale of a whole bucket.
>
> **Either retire `vaipakam-offchain-data-archive` first (#1977 carries
> the sequence, and this is the strongest argument for doing it), or run
> every step below against BOTH Workers and BOTH buckets**: pause both in
> step 1, enumerate and re-encrypt both in steps 2–3, `wrangler secret
> put` on both in step 4, and sweep both in step 6.
>
> This is separate from §1's compromise-time B2 **credential** rotation,
> which has its own two-Worker warning. Different keys, different step,
> same root cause — delete this box when the predecessor is retired.

1. Generate a NEW key locally:

   ```bash
   openssl rand -hex 32 > /tmp/new-backup-key
   ```

   Then **pause the archive Worker's schedule before enumerating**
   (**both Workers' schedules** while #1977 is open — see the box above) —
   disable the cron from the CF dashboard (Worker → Settings →
   Triggers) and note the time. If the rotation spans 03:17 UTC with
   the cron live, the Worker uploads a fresh OLD-key archive *after*
   your enumeration; steps 4–6 then switch the key, validate only
   new-key output, and destroy the old key — leaving that late
   archive (and its monthly/yearly siblings on a boundary date)
   permanently undecryptable (#1450 r31). Re-enable **both crons** after
   step 4 — the singular "the cron" here was the same one-Worker assumption
   this box exists to correct, and it is worse than the others: step 5
   requires a fresh archive from EVERY Worker, so leaving the predecessor
   disabled stalls the rotation outright, and skipping that validation
   instead leaves the fallback bucket silently receiving nothing (Codex
   #1978 r42). If the predecessor was retired before you started — the #1977
   sequence — there is one cron and this reads as written.

   **A dashboard pause does not survive a deploy — make the warm Worker's
   pause durable in its config.** `ops/offchain-data-warm/wrangler.jsonc`
   commits `"crons": ["17 3 * * *"]`, and a deploy republishes whatever that
   file says. Any `wrangler deploy` of that Worker between here and step 4 —
   somebody else's unrelated change, a CI deploy, your own step-4 command run
   early — silently re-arms the old-key writer AFTER steps 2–3 fixed the set
   of objects to migrate. The archive it then writes at 03:17 is old-key
   ciphertext nobody enumerated, and step 6 destroys the key that could read
   it. That is the #1450 r31 failure this pause exists to prevent, arriving
   through the door the dashboard does not close.

   So commit `"crons": []` in that file and deploy it, the way
   `apps/keeper/wrangler.jsonc` already holds an empty schedule for its own
   hold, and restore the committed schedule in step 4. Note the asymmetry
   while #1977 is open: `vaipakam-offchain-data-archive` has no config in this
   repository — that is the whole reason #1977 exists — so nothing here can
   redeploy it and the dashboard pause is the only lever it has. One Worker
   needs the config change; the other cannot have one.

   **Update the authority in the same sitting as the pause, before you begin
   step 2.** Disabling a cron removes a trigger from the account, so
   `docs/ops/CloudflareCronSlots.md` — the only place the count lives — now
   describes an account that no longer exists, and
   `node .github/scripts/check-cron-slots.mjs --live` fails for as long as the
   window lasts. That window is not short: step 2 enumerates every retained
   object across three tiers and both buckets, and step 3 decrypts,
   re-encrypts and re-verifies each one. Another operator reading the
   inventory during it would be told two Workers are armed that are not.

   For each Worker you paused: set its Schedule cell to `*(none)*`, set its
   Status to `reserved — paused for the encryption-key rotation, re-armed at
   step 4`, re-derive the three summary lines from the table, and re-stamp
   `Verified:` with the time you paused. Do not carry the numbers over from
   the old summary — derive them, which is what the gate checks.

   **Commit and push that, together with the `"crons": []` change above.** An
   edit sitting in your checkout is not the authority; the authority is what
   the shared repository says, and that is what another operator reads. If the
   rotation then aborts in the paused state this section explicitly supports,
   an uncommitted correction leaves the repository telling everyone else both
   Workers are live for as long as the pause lasts — which is the stale
   inventory #1977 is about, now produced by the procedure written to prevent
   it. The same applies in reverse at step 4: the restoration is committed and
   pushed too, not left local.

   **If the rotation aborts, the document follows the account, not the plan.**
   Stopping with the crons still paused is the safe stopping point — a paused
   Worker cannot write old-key ciphertext — so if you stop there, leave the
   rows reserved and record in the restore log that the pause is outstanding
   and why. Restore the rows only when the crons are actually back. Reverting
   the document because the procedure was abandoned, while the schedules stay
   off, manufactures exactly the stale inventory #1977 is about, and does it
   deliberately.

2. Enumerate and download **every retained ciphertext across all
   three tiers** — `archives/` (daily), `archives-monthly/`, and
   `archives-yearly/` — to a local workstation, **in EACH bucket while
   #1977 is open**. This step names tiers and not buckets, which reads as
   complete until you notice it never says where; an operator who has just
   come from §2 has been told to prefer the warm bucket, and would
   reasonably enumerate only that one. Three tiers times two buckets. The backup writer
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
   `vaipakam-offchain-data-warm` to flip the Worker to the new key —
   **and on `vaipakam-offchain-data-archive` too, for as long as that Worker
   still exists.** A Worker left on the old key keeps writing ciphertext that
   step 6 is about to make undecryptable; naming only the warm Worker here
   is what makes that easy to miss, since every other step reads as
   generic.

   ```bash
   ( cd ops/offchain-data-warm && wrangler secret put BACKUP_ENCRYPTION_KEY )
   wrangler secret put BACKUP_ENCRYPTION_KEY --name vaipakam-offchain-data-archive
   ```

   **The `--name` on the second is not optional** (Codex #1978 r33). The
   predecessor has no Wrangler config in this repository — that is the whole
   reason #1977 exists — so there is no directory to run it from. Without
   `--name`, Wrangler takes the Worker from the config it finds: run from
   `ops/offchain-data-warm` it silently rotates the WARM Worker a second time
   and reports success, leaving the predecessor on the old key; run from the
   repository root it finds no config at all.

   **Re-enable both schedules now, and restore the authority in the same
   sitting.** Put `"crons": ["17 3 * * *"]` back in
   `ops/offchain-data-warm/wrangler.jsonc` and deploy it — that is the warm
   Worker's re-arm, since step 1 made its pause durable in the config, and a
   dashboard toggle alone would be undone by the next deploy. Re-enable the
   archive Worker's cron from the dashboard, which is the only lever it has.
   Then put each Worker's schedule back in its Schedule cell in the authority,
   set its Status back to `live`, re-derive the three summary lines, re-stamp
   `Verified:`, and **commit and push both changes**. Step 1 took the rows
   down; this is where they come back. Doing it here rather than "at the end" matters because step 5 waits
   a full nightly cycle plus a weekly healthcheck: leaving the document
   describing paused Workers across that wait is a stale inventory lasting
   days, and it is the state in which someone else deploys a Worker into what
   the summary reports as spare capacity.

   Deliberately NOT "while it is still scheduled" (Codex #1978 r24): step 1
   disabled BOTH schedules and step 1's own note says to re-enable only after
   this step. So at this point neither Worker is scheduled, and an operator
   reading "while it is still scheduled" as a precondition would either skip
   the archive Worker's secret — the exact omission this sentence exists to
   prevent — or re-arm it early to satisfy the wording, putting it back to
   writing old-key ciphertext before its key has changed. Both of my own
   edits landed in the same commit; the pause instruction and the wording
   that contradicts it were written minutes apart.
5. Wait for one full nightly cycle + one weekly healthcheck. Both
   should land green on the new key.

   **Then DECRYPT fresh output from every Worker and every bucket with the
   retained offline new key, before step 6 destroys the old one** (Codex
   #1978 r28). A green run is not proof the key is right: a mistyped but
   valid 64-hex secret lets a Worker encrypt and upload successfully, and
   its own in-Worker verification uses that same mistyped value, so it
   agrees with itself. The warm Worker's weekly healthcheck reads only the
   warm bucket, so nothing at all examines the predecessor's output while
   #1977 is open — its bucket, the one §2 now names as a restore fallback,
   can quietly fill with ciphertext no retained key opens.
   Pull one archive written after step 4 from each bucket and decrypt it
   OFFLINE with the new key you hold. Only that proves the secret each
   Worker received is the secret you kept.
6. **Sweep for stragglers before retiring anything — in EVERY bucket you
   paused in step 1.** The old key is destroyed at the end of this step, so
   a bucket left unswept is a bucket whose stragglers become permanently
   undecryptable with no further warning. List every
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
