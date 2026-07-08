## Thread — alpha02 unit tests + a deterministic dynamic-faucet-label test (#1111)

The #1103 faucet change (labelling the relabelled second-liquid row from the
token's live on-chain `symbol()`) shipped with only an e2e smoke assertion. On
the Base-Sepolia fork that slot's symbol IS `mUSDC` — the same string the old
UI hard-coded — so the e2e test couldn't tell a genuinely dynamic label apart
from a regression back to a hard-coded one.

This adds a minimal **unit-test harness to `apps/alpha02`** (a `node`-environment
Vitest, no jsdom/React-Testing-Library) and moves the symbol-resolution logic
into a pure helper (`resolveMintSymbol`). The new `mintSymbol.test.ts` feeds a
deliberately non-`mUSDC` symbol and asserts it flows through to the button label
("Mint 10,000 tLQ2") — something a hard-coded `mUSDC` label could never
reproduce — and asserts the unresolved case falls back to the generic "test
stablecoin" label rather than a specific ticker. The suite runs in the existing
`defi vitest` CI gate (which now also covers `apps/alpha02`), so it can't rot
unrun.

No behaviour change — the faucet renders exactly as before; the resolution
logic was extracted verbatim into a tested helper. Closes #1111.
