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
 *  - The risk-access gate gates it too (Codex #1145 round-5):
 *    `previewMatchRiskBlock` must read 0 — `_executeMatch` asserts the
 *    creators' risk access on gated deployments, so an Ok previewMatch
 *    alone could still render a band the contract would refuse.
 *
 * Execution is PERMISSIONLESS — `matchOffers(lenderOfferId,
 * borrowerOfferId)`; `msg.sender` earns the LIF matcher kickback (1% of
 * the fee by default). The write goes through the desk's shared
 * `useDiamondWrite` + `captureTxError` pattern (same as the Open orders
 * panel's cancel).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { Zap } from 'lucide-react';
import { copy } from '../../content/copy';
import { useActiveChain } from '../../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../../contracts/diamond';
import { useMasterFlags } from '../../data/protocol';
import { assertWalletNotSanctionedLive } from '../../data/sanctions';
import { captureTxError } from '../../lib/errors';
import { flowDisabled } from '../../lib/killSwitch';
import { formatBpsAsPercent, formatTokenAmount } from '../../lib/format';
import {
  readMatchPreviewLive,
  readMatchRiskBlockLive,
  topOfBookMatchPair,
  usePreviewMatch,
  usePreviewMatchRiskBlock,
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
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const flags = useMasterFlags();

  // Top-of-book pair (on-chain offers only — matchOffers can't cross a
  // signed row; see topOfBookMatchPair). Null when not crossed.
  const pair = topOfBookMatchPair(ladder);
  // The preview hook self-disables on a null pair; keying on the ids
  // means a book change (new top of book) re-runs it automatically.
  const preview = usePreviewMatch(pair);
  // Risk-access gate mirror (Codex #1145 round-5 P2): previewMatch Ok
  // alone is NOT sufficient on risk-gated deployments —
  // `OfferMatchFacet._executeMatch` also runs
  // `_assertMatchCreatorsRiskAccess(lenderOfferId, borrowerOfferId)`
  // (OfferMatchFacet.sol:930), whose non-reverting mirror is
  // `RiskPreviewFacet.previewMatchRiskBlock` (RiskPreviewFacet.sol:220).
  // Anything but 0 means the write would revert; see the hook for the
  // missing-selector (fail-open) vs transport-failure (fail-closed)
  // postures.
  const riskBlock = usePreviewMatchRiskBlock(pair);

  const [busy, setBusy] = useState(false);
  // Executed / failed state is KEYED to the pair it happened on (Codex
  // #1145 round-1 P2 #3): the component lives across book refetches, so
  // plain booleans would leak the previous pair's terminal state onto a
  // NEW crossable pair (a fresh matchable pair rendering "Match
  // executed", or a stale error). Deriving `done`/`error` from a
  // stored pair key means a top-of-book change resets both for free —
  // no effect, no one-frame stale flash.
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<{
    key: string;
    message: string;
  } | null>(null);

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
  // …and only a clear risk gate (0). Loading (`undefined`) and
  // transport failure (`null`) both hide — fail closed while unknown,
  // consistent with the masterFlags posture above. A missing selector
  // on an older Diamond already resolved to 0 inside the hook (fail
  // open — the direct-accept path's posture for a missing
  // `previewOfferAcceptBlock`; the contract still enforces at write
  // time, and the live recheck in execute() re-asks anyway).
  if (riskBlock.data !== 0) return null;

  const pairKey = `${pair.lenderOfferId}:${pair.borrowerOfferId}`;
  const done = doneKey === pairKey;
  const error =
    errorState !== null && errorState.key === pairKey
      ? errorState.message
      : null;

  async function execute() {
    setBusy(true);
    setErrorState(null);
    try {
      if (!address || !walletChain || !publicClient) {
        throw new Error(copy.wallet.connectFirst);
      }
      // 1) Screen the MATCHER live (Codex #1145 round-5 P2):
      // `matchOffers` runs `LibVaipakam._assertNotSanctioned(msg.sender)`
      // (OfferMatchFacet.sol:296 — the matcher is the LIF recipient), so
      // a flagged wallet would pay gas into SanctionedAddress. Standard
      // guard every write flow uses; fail-open on read errors — the
      // contract still screens this path.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // 2) Re-confirm matchability LIVE, right before the write (Codex
      // #1145 round-5 P2): the rendered band rides a 30s-interval cache,
      // so a partial fill / cancel / rate move since the last refetch
      // could leave a stale Ok on screen and submit a doomed
      // `matchOffers`. Direct reads (never the cached query), one
      // round-trip: the contract's own `previewMatch` verdict plus the
      // risk-gate mirror (`_executeMatch` enforces both — see the
      // render-time comments), plus the `partialFill` MASTER FLAG
      // (Codex #1145 round-6 P2): the rendered flag rides
      // useMasterFlags' 10-min staleTime, and `matchOffers` re-checks
      // `s.protocolCfg.partialFillEnabled` at runtime — reverting
      // `FunctionDisabled(3)` when governance switched it off
      // (OfferMatchFacet.sol:184-188) — while `previewMatch` does NOT
      // mirror that flag (OfferMatchFacet.sol:140-146 delegates to
      // `LibOfferMatch.previewMatch`, which never reads it; only the
      // intent preview does, LibOfferMatch.sol:734), so the preview
      // recheck alone would wave a doomed write through. Same read
      // shape as useMasterFlags (`getMasterFlags` tuple, index 2 =
      // partialFill); an unreadable flag resolves `null` → abort (fail
      // closed, the render-time posture). Non-Ok / blocked / flag-off /
      // unreadable all abort BEFORE gas; the invalidations below
      // re-sync the band with what the chain just said (it hides or
      // re-renders on fresh data).
      const [livePreview, liveRisk, livePartialFill] = await Promise.all([
        readMatchPreviewLive(publicClient, walletChain.diamondAddress, pair!),
        readMatchRiskBlockLive(publicClient, walletChain.diamondAddress, pair!),
        (
          publicClient.readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getMasterFlags',
          }) as Promise<readonly [boolean, boolean, boolean]>
        )
          .then((flags) => flags[2])
          .catch(() => null),
      ]);
      if (livePartialFill !== true) {
        // Refetching masterFlags unmounts the band (the render gate
        // above keys on it) — the honest end state for a kill-switch
        // flip, with its own copy (a "book moved" message would lie).
        void queryClient.invalidateQueries({ queryKey: ['masterFlags'] });
        throw new Error(text.matchingDisabled);
      }
      if (livePreview === null || livePreview.errorCode !== 0 || liveRisk !== 0) {
        void queryClient.invalidateQueries({ queryKey: ['deskPreviewMatch'] });
        void queryClient.invalidateQueries({ queryKey: ['deskBook'] });
        throw new Error(text.noLongerMatchable);
      }
      // 3) The write.
      await write('matchOffers', [
        BigInt(pair!.lenderOfferId),
        BigInt(pair!.borrowerOfferId),
      ]);
      setDoneKey(pairKey);
      void queryClient.invalidateQueries({ queryKey: ['deskBook'] });
      void queryClient.invalidateQueries({ queryKey: ['deskMarkets'] });
      void queryClient.invalidateQueries({ queryKey: ['deskTape'] });
      void queryClient.invalidateQueries({ queryKey: ['deskPreviewMatch'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
    } catch (err) {
      setErrorState({ key: pairKey, message: captureTxError(err) });
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
