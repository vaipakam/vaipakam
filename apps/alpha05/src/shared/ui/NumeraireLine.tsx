import { useEffect, useState } from 'react';
import { useCopy } from '../copy/useCopy';
import { useChainRead, useScreenChain } from '../reads/chainRead';
import { readNumeraireSymbol } from '../reads/numeraire';
import { equivalentText, readNumeraireEquivalent, type ValueLeg } from '../reads/numeraireValue';

type Hex = `0x${string}`;

/** How long typing must pause before the value is read again. */
const SETTLE_MS = 400;

/**
 * RB-CLICKS — the line under a typed amount stating its value in the
 * numeraire, as the protocol values it now (`numeraireValue`): a figure for
 * a liquid asset, "no price" for one the protocol values at nothing, the
 * price sources' disagreement when that is why, and an unread value as
 * unread. Nothing is shown until the amount parses to more than zero.
 * The value is read once typing pauses, so each keystroke is not a read.
 */
export function NumeraireLine({
  asset,
  amount,
  leg,
  assetLabel,
  testId,
}: {
  asset: Hex | null;
  amount: bigint | null;
  leg: ValueLeg;
  assetLabel: string;
  testId: string;
}) {
  const { text, format } = useCopy();
  const chain = useScreenChain();
  const diamond = chain.diamondAddress;
  const [settled, setSettled] = useState(amount);
  useEffect(() => {
    const t = setTimeout(() => setSettled(amount), SETTLE_MS);
    return () => clearTimeout(t);
  }, [amount]);
  const on = asset !== null && settled !== null && settled > 0n;
  const eq = useChainRead(
    ['numeraireEquivalent', diamond, asset?.toLowerCase(), settled?.toString(), leg],
    (c) => readNumeraireEquivalent(c, diamond, asset!, settled!, leg),
    { enabled: on },
  );
  const unit = useChainRead(['numeraireSymbol', diamond], (c) => readNumeraireSymbol(c, diamond), { enabled: on });
  if (!on || amount === null || amount <= 0n) return null;
  const line =
    settled !== amount || eq.state === 'reading'
      ? { tier: 'tier-b', state: 'reading', words: text('numeraire.reading') }
      : eq.state === 'failed' || eq.data === null
        ? {
            tier: 'tier-a',
            state: 'failed',
            words: format('numeraire.failed', {
              reason: eq.error ?? 'no answer',
            }),
          }
        : {
            tier: eq.data.kind === 'value' ? 'tier-b' : 'tier-a',
            state: eq.data.kind,
            words: equivalentText(eq.data, unit.data, assetLabel, {
              text,
              format,
            }),
          };
  return (
    <p className={`${line.tier} field-hint numeraire-line`} aria-live="polite" data-testid={testId} data-equivalent={line.state}>
      {line.words}
    </p>
  );
}
