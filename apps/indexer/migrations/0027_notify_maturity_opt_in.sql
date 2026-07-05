-- #1033 (alpha02 alert rails): the Alerts card exposes "message me
-- before an interest payment comes due" as a real opt-out. The flag
-- rides user_thresholds — the agent's PUT /thresholds writes it and
-- runPeriodicPreNotify skips rows that opted out. DEFAULT 1 keeps
-- every existing row opted in (today's behaviour, unchanged).
ALTER TABLE user_thresholds ADD COLUMN notify_maturity_approaching INTEGER NOT NULL DEFAULT 1;
