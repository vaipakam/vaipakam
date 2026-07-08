## Thread — faucet second-liquid row labels from the live token symbol (#1103)

The testnet faucet's second liquid token is the slot that gets **relabelled**
(the pre-#1095 `tLQ2` became the `$1` mock-USDC). Its row title and Mint button
were hard-coded to "mUSDC", so during the narrow window where the shipped
frontend bundle still points that slot at the pre-relabel token (before an
operator reruns the mock deploy + the deployments sync), the row would advertise
"mUSDC" while a click actually minted the old token.

The row now reads the token's **live on-chain `symbol()`** and labels the title
("Mock USD Coin (<symbol>)") and the Mint button ("Mint 10,000 <symbol>") from
it. This mirrors what the faucet already did at mint time for the success toast
and `wallet_watchAsset`, so the pre-click label can no longer disagree with what
the click mints. Until the read resolves — or if it errors — the row shows a
**generic** label ("Mock USD Coin (test stablecoin)" / "Mint 10,000 test
stablecoin") rather than asserting a specific ticker it hasn't confirmed, so a
slow or failed read can't re-open the very stale-label window this closes. The
other faucet rows keep their static tickers because those slots aren't
relabelled.

Testnet-faucet-only, cosmetic, transient — the mocks are currently deployed
with mUSDC live, so the label is already accurate today; this hardens the
redeploy-transition window. Closes #1103.
