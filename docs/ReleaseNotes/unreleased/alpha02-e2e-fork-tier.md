## Thread — alpha02 automatic regression: the anvil fork tier

The regression procedure documented in
`docs/TestScopes/Alpha02RegressionFlows.md` gets its executable half: a
checked-in Playwright suite (`apps/alpha02/e2e/`) that runs the real
app against an anvil FORK of Base Sepolia — the deployed Diamond's
live bytecode and state, but disposable and time-travelable.

The pieces: an injected EIP-1193/6963 test wallet whose keys are
generated fresh per run and funded via anvil (no secrets exist,
anywhere); an "instant indexer" stub that serves the app's exact
indexer routes hydrated live from the fork's own paginated chain
views (zero ingestion lag); fork seeding that gives each role wallet
WETH and faucet tLIQ; and time travel via evm_increaseTime, which
makes the protocol's time behaviours — the 300-second cancel
cooldown today; maturities, grace windows and time-based default
next — testable in seconds instead of days.

Six scenarios land first (connect, post offer, guided-match accept,
full repay, cancel-inside-then-after-cooldown, faucet mint with the
wallet watch-asset affordance), each asserting BOTH the visible UI
state and the on-chain result. A new `alpha02 e2e (anvil fork)`
workflow runs them automatically on pull requests touching
`apps/alpha02/**` or `packages/contracts/**` (the artifacts through
which contract changes actually reach the app), plus a nightly run
that catches the live testnet moving under an unchanged app.
