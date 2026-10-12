/**
 * #2390 — the one hint every money input shows when the typed amount has
 * more decimals than the token. The amount is refused, never rounded: the
 * contract can only move whole base units, so a rounded parse would send a
 * figure other than the one the confirmation echoes back.
 *
 * Renders nothing while the decimals are unknown (the token metadata has
 * not loaded) or the text is fine — a malformed amount is the input's own
 * "invalid" message to give, not this one.
 */
import { copy } from '../content/copy';
import { isTooPrecise } from '../lib/format';

export function AmountPrecisionHint({
  value,
  decimals,
  symbol,
  testId,
}: {
  value: string | null | undefined;
  decimals: number | undefined;
  symbol: string;
  testId?: string;
}) {
  if (decimals === undefined || !value || !isTooPrecise(value, decimals)) {
    return null;
  }
  return (
    <span
      className="field-hint"
      role="alert"
      data-testid={testId ?? 'amount-too-precise'}
      style={{ display: 'block', color: 'var(--danger)', marginTop: 4 }}
    >
      {copy.common.amountTooPrecise(symbol, String(decimals))}
    </span>
  );
}
