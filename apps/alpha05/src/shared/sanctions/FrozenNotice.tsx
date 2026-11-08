import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { useOwnRead } from '../reads/useOwnRead';
import { Notice } from '../ui/Notice';
import { frozenState, readSanctionsPosture, type FrozenState } from './posture';

type Hex = `0x${string}`;

/** The connected wallet's frozen state on this chain (RB-FROZEN), one read
 *  shared by every surface that shows it. Undefined until first read. */
export function useFrozenState(diamond: Hex, wallet: Hex | null): FrozenState | undefined {
  const posture = useOwnRead(['sanctions', diamond, wallet ?? ''], (c) => readSanctionsPosture(c, diamond, wallet!), { enabled: wallet !== null });
  if (posture.data === null) return posture.state === 'failed' ? 'unknown' : undefined;
  return frozenState(posture.data);
}

/** LN-53 — "Frozen, awaiting de-listing" on Claims: shown only when the
 *  sanctions screen flags this wallet, when it cannot be read and the wallet
 *  was confirmed flagged before, or when the wallet's standing could not be
 *  read (then said, never assumed either way). */
export function FrozenNotice({ state }: { state: FrozenState | undefined }) {
  const { text } = useCopy();
  if (state === undefined || state === null) return null;
  const key = state === 'flagged' ? 'frozen.noticeFlagged' : state === 'outage' ? 'frozen.noticeOutage' : 'frozen.noticeUnknown';
  return (
    <div data-testid="frozen-notice" data-state={state}>
      <Notice tone={state === 'unknown' ? 'info' : 'warn'} tier="A">
        {state !== 'unknown' && <strong>{text('frozen.noticeTitle')} </strong>}
        {text(key)}
      </Notice>
      <WhyLink summaryKey="frozen.whySummary" detailKey="frozen.why" />
    </div>
  );
}
