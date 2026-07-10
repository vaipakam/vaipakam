/**
 * Crossable-band previewMatch strip (#1131 slice B) — rendered at the
 * ladder's mid row when the book is crossed AND the contract itself
 * says the top-of-book pair is matchable.
 *
 * Honesty rules (ProRateTerminalDesign §5.2 — the core rule of this
 * surface):
 *  - bid >= ask alone is NOT matchable: range offers' amount/collateral
 *    constraints can still fail, so the band renders ONLY when
 *    `previewMatch(lenderOfferId, borrowerOfferId)` returns
 *    `errorCode == 0` (Ok). Any non-Ok code → NO band, no explanation
 *    strip — a crossed-but-unmatchable book is a normal resting state.
 *  - The governance kill switch gates it: `getMasterFlags().partialFill`
 *    is the runtime gate on `matchOffers`, so flags unknown or OFF →
 *    nothing (fail closed for an advisory surface).
 *
 * Execution is PERMISSIONLESS — `matchOffers(lenderOfferId,
 * borrowerOfferId)`; `msg.sender` earns the LIF matcher kickback (1% of
 * the fee by default). The write goes through the desk's shared
 * `useDiamondWrite` + `captureTxError` pattern (same as the Open orders
 * panel's cancel).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { copy } from '../../content/copy';
import { useActiveChain } from '../../chain/useActiveChain';
import { useDiamondWrite } from '../../contracts/diamond';
import { useMasterFlags } from '../../data/protocol';
import { captureTxError } from '../../lib/errors';
import { flowDisabled } from '../../lib/killSwitch';
import { formatBpsAsPercent, formatTokenAmount } from '../../lib/format';
import {
  topOfBookMatchPair,
  usePreviewMatch,
  type DeskLadder,
} from '../../data/desk';

const text = copy.desk.match;

export function MatchBand({
  ladder,
  decimals,
  symbol,
}: {
  ladder: DeskLadder;
  decimals: number | undefined;
  symbol: string | undefined;
}) {
  const { onSupportedChain } = useActiveChain();
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const flags = useMasterFlags();

  // Top-of-book pair (on-chain offers only — matchOffers can't cross a
  // signed row; see topOfBookMatchPair). Null when not crossed.
  const pair = topOfBookMatchPair(ladder);
  // The preview hook self-disables on a null pair; keying on the ids
  // means a book change (new top of book) re-runs it automatically.
  const preview = usePreviewMatch(pair);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Executing a match INITIATES a loan for the two makers — gate it on
  // the same operator kill switch as accepting an offer.
  const killed = flowDisabled('accept-offer');

  // Governance kill switch: partialFill gates matchOffers at runtime.
  // Unknown flags (loading / read failure) also hide — fail closed.
  if (flags.data?.partialFill !== true) return null;
  if (pair === null) return null;
  const p = preview.data;
  // §5.2: ONLY a contract-confirmed Ok preview may render the band.
  if (!p || p.errorCode !== 0) return null;

  async function execute() {
    setBusy(true);
    setError(null);
    try {
      await write('matchOffers', [
        BigInt(pair!.lenderOfferId),
        BigInt(pair!.borrowerOfferId),
      ]);
      setDone(true);
      void queryClient.invalidateQueries({ queryKey: ['deskBook'] });
      void queryClient.invalidateQueries({ queryKey: ['deskMarkets'] });
      void queryClient.invalidateQueries({ queryKey: ['deskTape'] });
      void queryClient.invalidateQueries({ queryKey: ['deskPreviewMatch'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="desk-match-band"
      role="status"
      title={`${p.matchRateBps} bps · offers #${pair.lenderOfferId} × #${pair.borrowerOfferId}`}
    >
      <span className="desk-match-band-main">
        <Zap size={14} aria-hidden />
        <span>
          <strong>{text.matchable(formatBpsAsPercent(p.matchRateBps))}</strong>{' '}
          — {text.body}
          {decimals !== undefined ? (
            <>
              {' '}
              {text.amount(
                formatTokenAmount(p.matchAmount, decimals),
                symbol ?? '',
              )}
            </>
          ) : null}
        </span>
      </span>
      {done ? (
        <span className="desk-match-band-done">{text.executed}</span>
      ) : (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || !onSupportedChain || killed}
          onClick={() => void execute()}
        >
          {busy ? text.executing : text.execute}
        </button>
      )}
      {error ? (
        <span className="desk-match-band-error">{error}</span>
      ) : null}
    </div>
  );
}
