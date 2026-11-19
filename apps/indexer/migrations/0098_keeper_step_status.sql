-- #3681 — which keeper steps this deployment's keeper is running, where the
-- app can read it.
--
-- A borrower who turns on a standing instruction (a collateral top-up, a due
-- repayment, an interest payment) authorises anyone to run it; that is not a
-- promise that someone will. Each step of the keeper's `standingInstructions`
-- pass has its own arming flag, set or not per deployment. The keeper writes
-- here, every few minutes while it runs, whether each step is armed, and the
-- indexer serves it read-only on `GET /keeper/steps?chainId=`, so the app can
-- say "No automatic runner is active for this instruction here" where it is
-- not, and say the same when the state cannot be read or is stale.
--
--   chain_id    — the deployment's chain.
--   diamond     — the Diamond the keeper serves there, lowercase, so a reader
--                 can tell a row written for another deployment.
--   pass, step  — the keeper pass and its step ('standingInstructions' with
--                 'topUp', 'repay' or 'interest'; 'protectedAccount' with
--                 'alerts', 'alertsTelegram' or 'alertsPush', #3756;
--                 'matcher' with 'roll', the re-lending of repayments, #3763).
--   armed       — 1 when the step's flag (and the keeper itself) is armed.
--                 Not "it will succeed": the contract decides each call.
--   observed_at — when the keeper last read its own flags (unix seconds, the
--                 keeper's clock). A row older than the route's freshness
--                 bound is read as not running, never as the last word.
--
-- Additive: a new table nothing deployed reads or writes. Chain-scoped, so a
-- fresh Diamond resets it with the rest; the keeper rewrites it within
-- minutes.
CREATE TABLE IF NOT EXISTS keeper_step_status (
  chain_id    INTEGER NOT NULL,
  diamond     TEXT    NOT NULL CHECK (diamond = lower(diamond) AND length(diamond) = 42),
  pass        TEXT    NOT NULL CHECK (length(pass) BETWEEN 1 AND 64),
  step        TEXT    NOT NULL CHECK (length(step) BETWEEN 1 AND 64),
  armed       INTEGER NOT NULL CHECK (armed IN (0, 1)),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, pass, step)
);
