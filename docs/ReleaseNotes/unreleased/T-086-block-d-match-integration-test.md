## T-086 Block D — integration test for the Match-button rewire

Adds a focused vitest integration test for `useNFTPrepayListing.matchOpenSeaOffer`
that pins the new agent-proxy URL shape (`?fulfiller=<vaultAddress>&quantity=<lotSize>`)
+ the borrower-vault short-circuit + the agent-fetch failure modes
from PR #349. The test is structurally correct but currently skipped
behind `describe.skip` pending Issue #85 — the shared
`test/setup.ts`'s `localStorage.clear()` throws against the vitest 4 +
jsdom 29 environment in this monorepo and the whole vitest suite is
intentionally not wired into CI for that reason. When #85 lands the
skip flips back to a normal `describe`.

No code paths change; this is test-only intent capture.
