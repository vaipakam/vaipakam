-- #3088 — the Telegram LOCK command for protected account mode.
--
-- An owner whose wallet is linked to a Telegram chat may send LOCK from that
-- chat to have the keeper lock their protected account at once
-- (`ProtectedAccountFacet.lockVaultFor`). The agent receives the message (it
-- owns the Telegram webhook) and records one row per wallet and chain the
-- chat is linked for; the keeper, the only signer, reads the rows it has not
-- handled yet, makes the call when the chain allows it, answers in the same
-- chat and records on the row what it did. The agent signs nothing.
--
-- A row is a request, not a lock: the keeper locks only an account that has
-- protected mode on and has granted the keeper the lock permission, and says
-- in the chat which it did. The keeper's progress is on the row itself
-- (`handled_at`), not a cursor of its own: a cursor in the keeper's private
-- database would outlive this table's ids when the shared database is rebuilt
-- (restore clears this table, and a fresh table numbers from 1 again), and
-- every new request would then sit below it, unread.
--
-- No chat id is kept here: the keeper answers in the chat the wallet is
-- linked to WHEN it answers (`user_thresholds.tg_chat_id`). So unlinking
-- Telegram stops every reply at once, including one to a request already
-- waiting, and nothing here ties a wallet to a chat after the link is gone;
-- the lock itself is still made, since the owner asked for it.
--
--   id            — the order the keeper reads rows in.
--   chain_id      — the chain the chat is linked for.
--   wallet        — lowercase 0x-hex, the linked wallet (the account owner).
--   update_id     — Telegram's id for the update, so a redelivered update
--                   records nothing new.
--   requested_at  — unix seconds, when the agent received it. The keeper
--                   drops a request it reaches more than an hour later, and
--                   says so in the chat, rather than lock long after asked.
--   handled_at    — unix seconds, when the keeper finished the request; NULL
--                   while it waits. Written only by the keeper.
--   outcome       — what the keeper did: locked, already-locked,
--                   not-protected, not-allowed, expired, dropped-old, or
--                   `refused: <reason>`. NULL while it waits.
--
-- Chain-scoped (carries chain_id), so a fresh Diamond's epoch reset clears it
-- with the chain's other rows: a request names an account on the Diamond it
-- was made against.

CREATE TABLE IF NOT EXISTS protected_lock_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id     INTEGER NOT NULL,
  wallet       TEXT NOT NULL,
  update_id    INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  handled_at   INTEGER,
  outcome      TEXT,
  UNIQUE (update_id, chain_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_protected_lock_requests_open ON protected_lock_requests(chain_id, handled_at, id);

-- Whether a keeper is working LOCK requests on a chain now. The keeper's
-- protected account pass writes `seen_at` (unix seconds) at the start of
-- every run its LOCK step is armed for and it can sign; the agent records a LOCK only for a
-- chain whose row is fresh, and otherwise tells the owner to lock from the
-- app, so an owner is never told a lock is coming when nothing will act on
-- it (the agent cannot read the keeper's flags, which live on its own
-- machine). Chain-scoped: a fresh Diamond's epoch reset clears it, and the
-- keeper writes it again on its next run.
CREATE TABLE IF NOT EXISTS protected_lock_readiness (
  chain_id INTEGER PRIMARY KEY,
  seen_at  INTEGER NOT NULL
);
