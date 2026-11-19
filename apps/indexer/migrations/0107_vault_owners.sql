-- #3388 — each user vault's owner, so a vault outflow paid INTO a vault is
-- filed under that vault's owner on the Activity page.
--
-- Since #3205 part 2 every vault outflow emits `VaultOutflow(owner, vault,
-- asset, …, to, class_, reason, ref)`. Holder payouts, claim custody and
-- matched legs pay a VAULT, so `to` is a vault contract, which matches no
-- wallet: the holder saw the row only through the loan filter. The indexer
-- now adds the receiving vault's owner to the row's args as `recipientOwner`
-- (`INDEXER_ADDED_PARTIES` in packages/lib/src/activityParticipants.ts), and
-- this table is where it looks that owner up.
--
-- vault_owners: one row per (chain, vault). A vault's owner never changes
-- (one proxy per user, created by the Diamond's factory). Written by the
-- indexer from `UserVaultCreated(user, proxy)` and from every
-- `VaultOutflow`'s own (owner, vault) pair. chain_id is a Diamond chain, so
-- the rows are reset with the chain's other rows when a fresh Diamond is
-- adopted, which is right: a new Diamond has new vaults.
--
-- Addresses are lower-cased 0x-40-hex, as the participant rule writes them.
CREATE TABLE IF NOT EXISTS vault_owners (
  chain_id INTEGER NOT NULL,
  vault    TEXT    NOT NULL CHECK (vault = lower(vault) AND length(vault) = 42),
  owner    TEXT    NOT NULL CHECK (owner = lower(owner) AND length(owner) = 42),
  PRIMARY KEY (chain_id, vault)
);

-- Seed from the events already stored: every vault creation, then every
-- outflow's own owner/vault pair. `json_valid` first: `json_extract` raises
-- on text that is not JSON; only 0x-40 address strings are taken.
INSERT OR IGNORE INTO vault_owners (chain_id, vault, owner)
SELECT chain_id, lower(json_extract(args_json, '$.proxy')), lower(json_extract(args_json, '$.user'))
  FROM activity_events
 WHERE kind = 'UserVaultCreated'
   AND json_valid(args_json)
   AND json_type(args_json, '$.proxy') = 'text' AND length(json_extract(args_json, '$.proxy')) = 42
   AND json_extract(args_json, '$.proxy') GLOB '0x[0-9a-fA-F]*'
   AND json_type(args_json, '$.user') = 'text' AND length(json_extract(args_json, '$.user')) = 42
   AND json_extract(args_json, '$.user') GLOB '0x[0-9a-fA-F]*';

INSERT OR IGNORE INTO vault_owners (chain_id, vault, owner)
SELECT chain_id, lower(json_extract(args_json, '$.vault')), lower(json_extract(args_json, '$.owner'))
  FROM activity_events
 WHERE kind = 'VaultOutflow'
   AND json_valid(args_json)
   AND json_type(args_json, '$.vault') = 'text' AND length(json_extract(args_json, '$.vault')) = 42
   AND json_extract(args_json, '$.vault') GLOB '0x[0-9a-fA-F]*'
   AND json_type(args_json, '$.owner') = 'text' AND length(json_extract(args_json, '$.owner')) = 42
   AND json_extract(args_json, '$.owner') GLOB '0x[0-9a-fA-F]*';

-- Give the stored outflows paid into a known vault their recipient's owner,
-- the same field new rows carry, and file them under that owner for the
-- server's wallet history (`activity_participants`, #3677). Only rows that
-- do not already carry the field; idempotent.
UPDATE activity_events
   SET args_json = json_set(
         args_json,
         '$.recipientOwner',
         (SELECT vo.owner FROM vault_owners vo
           WHERE vo.chain_id = activity_events.chain_id
             AND vo.vault = lower(json_extract(activity_events.args_json, '$.to')))
       )
 WHERE kind = 'VaultOutflow'
   AND json_valid(args_json)
   AND json_type(args_json, '$.recipientOwner') IS NULL
   AND json_type(args_json, '$.to') = 'text'
   AND EXISTS (SELECT 1 FROM vault_owners vo
                WHERE vo.chain_id = activity_events.chain_id
                  AND vo.vault = lower(json_extract(activity_events.args_json, '$.to')));

INSERT OR IGNORE INTO activity_participants (chain_id, block_number, log_index, wallet)
SELECT chain_id, block_number, log_index, json_extract(args_json, '$.recipientOwner')
  FROM activity_events
 WHERE kind = 'VaultOutflow'
   AND json_valid(args_json)
   AND json_type(args_json, '$.recipientOwner') = 'text';
