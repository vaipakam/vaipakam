/**
 * Faucet mint-symbol resolution (#1103 / #1111).
 *
 * The second-liquid faucet slot gets RELABELLED (tLQ2 → mUSDC), so its
 * row/button label must reflect the token's LIVE on-chain `symbol()`, never a
 * hard-coded ticker — otherwise, during the window where the shipped bundle
 * still points that slot at the pre-relabel token, it would advertise a symbol
 * a click wouldn't actually mint.
 *
 * `Faucet.tsx` reads `symbol()` via wagmi (which yields `unknown` until it
 * resolves). This helper normalises that raw read into `string | null`:
 *   - a non-empty string → the live ticker
 *   - anything else (loading `undefined`, an errored read, a non-string, an
 *     empty string) → `null`, so the caller shows a GENERIC label instead of
 *     asserting a specific ticker it hasn't confirmed (Codex #1109 P2).
 *
 * Extracted as a pure function so the dynamic-vs-hard-coded behaviour is
 * unit-testable without a component/RPC harness (#1111): a test can feed a
 * non-`mUSDC` symbol and assert it flows through, which a regression back to a
 * hard-coded `"mUSDC"` label could never pass.
 */
export function resolveMintSymbol(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
