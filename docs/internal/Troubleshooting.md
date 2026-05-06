## Fix the Broken Git

if `git` got borken then run the following command
Ref: https://stackoverflow.com/questions/11706215/how-can-i-fix-the-git-error-object-file-is-empty

```bash
find .git/objects/ -type f -empty -delete
git fetch -p
git fsck --full
```

## To softly remove top N commits from local

`git reset --soft HEAD~N`

replace N with number of top commits that need to be reverted

## To untrack a file, in case if its added to gitignore

`git rm --cached docs/internal/RoughNotes.md`

## How to purge the testnet state

1. Purge D1 (watcher's database)
   The repo already has a per-chain purge script: ops/hf-watcher/scripts/purge-chain.sh. Run from the worker dir:

cd ops/hf-watcher

# Base Sepolia

bash scripts/purge-chain.sh 84532

# Arb Sepolia

bash scripts/purge-chain.sh 421614

# OP Sepolia

bash scripts/purge-chain.sh 11155420
It prints the row counts per table, asks [y/N], then deletes from offers / loans / activity_events / indexer_cursor / user_thresholds / notify_state / telegram_links / diag_errors for that chain. Wiping indexer_cursor is the key bit — the next cron tick re-indexes from deployBlock. To skip the prompt: FORCE=1 bash scripts/purge-chain.sh 84532.

After purging, redeploy the worker so the new root-cause-fix code is what handles the re-index:

cd ops/hf-watcher
npx wrangler deploy 2. Purge browser localStorage
Three ways (any one works):

(a) DevTools → Application → Storage → Clear site data — most thorough. Also clears IndexedDB, service worker cache, cookies for the origin.

(b) From the browser console on the app's tab:

localStorage.clear();
sessionStorage.clear();
location.reload();
(c) For just specific keys (if you want to keep wallet connection but reset app state):

Object.keys(localStorage).filter(k => k.startsWith('vaipakam-') || k.includes('toast'))
.forEach(k => localStorage.removeItem(k));
The wallet/wagmi connection state is in keys like wagmi._ / wc@_ — leaving those alone keeps your connection live across the reload.
