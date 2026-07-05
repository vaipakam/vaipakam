## Thread — faucet gains a second illiquid token (tILQ2) so both-unpriced deals are testable

The Get-test-assets page swaps its "Second liquid test token (tLQ2)"
card for a new "Second illiquid test token (tILQ2)". The faucet now
dispenses two oracle-priced tokens (tLIQ, mWETH) and two unpriced
tokens (tILQ, tILQ2), so a reviewer can run a deal where NEITHER the
lending asset nor the collateral has a price — the fully-consent-based
path: both sides must explicitly agree, no health factor applies, and
a default hands the collateral over in kind. Previously that scenario
required hand-pasting a token address; the second liquid pairing the
tLQ2 card used to explain (health-factor, liquidation, and refinance
demos need two different liquid tokens) is now covered by pairing tLIQ
with mWETH, and the tLIQ card says so.

The new token is a plain mintable test ERC-20 deployed on Base Sepolia
with deliberately NO price-feed or pool wiring — that absence is what
classifies it illiquid to the protocol. The tLQ2 token itself remains
on-chain with its oracle wiring intact (existing offers and loans that
reference it are untouched); it simply no longer appears on the
faucet. The functional spec's faucet passage now states the intent
directly: at least two liquid and two illiquid test tokens so both
both-liquid and both-unpriced deals are testable from faucet supply
alone.
