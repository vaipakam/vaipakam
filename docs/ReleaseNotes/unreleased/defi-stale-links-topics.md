### Fixed: dead loan links and a blind live-tail in the pro app

Two defi-side fixes (#1057, #1064):

- Several places still pointed at the loan-details page's old address
  from before the app's routes were flattened — the "View loan"
  button on offer details, claim rows, activity rows, the offers
  table, and the rewards history, plus the loan links inside
  keeper-sent Telegram/Push alerts. All landed on "page not found".
  Every link now uses the current address, and the old address keeps
  working as a redirect so alert messages delivered before this fix
  still land on the loan.
- The pro app's near-realtime catch-up (the scan that bridges the gap
  between the market cache and the chain head) recognised events by
  hand-typed signatures that had silently drifted from the deployed
  contracts — a drifted signature matches nothing, so the catch-up
  went quietly blind. The event signatures are now derived from the
  compiled contract definitions themselves (the same single-source
  rule the indexer and alpha02 already follow), and a renamed event
  now fails loudly in tests instead of silently matching nothing.
