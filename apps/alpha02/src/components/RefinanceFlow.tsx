/**
 * Borrower refinance — the T-092-H tagged-atomic path, advanced mode.
 *
 * The borrower posts a refinance-tagged Borrower offer for EXACTLY the
 * old loan's principal, with the old collateral's identity repeated so
 * it CARRIES OVER (nothing is pulled at create; the lien re-tags
 * old→new inside the lender's accept). The moment any lender accepts,
 * one transaction: new loan opens → old lender is paid principal +
 * full-term remaining interest from the borrower's wallet (via the
 * standing approval set here) → old loan closes → collateral moves.
 *
 * Three wallet steps behind ONE reviewed confirm:
 *   1. setAutoRefinanceCaps — on-chain guardrails at the reviewed
 *      rate ceiling and end-date window (skipped when already
 *      sufficient).
 *   2. Standing approval on the old principal asset for the payoff
 *      (exact; the pull only shrinks as partials settle interest).
 *   3. createOffer with the refinance tag.
 *
 * A posted request is remembered locally (no indexer column for the
 * tag yet) and verified LIVE against getOfferDetails every render of
 * the pending banner — cancel deletes the offer record on-chain, so a
 * zeroed creator means "gone" and the marker self-heals.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseEventLogs } from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, submitErrorText } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance } from '../contracts/erc20';
import {
  assertAssetNotPausedLive,
  assertErc20BalanceLive,
  assertPositionNftHeldLive,
} from '../contracts/preflights';
import {
  LOAN_STATUS_ACTIVE,
  interestRemainingDaysOf,
  readLoanLive,
  type LoanLive,
} from '../contracts/loanLive';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import { useProtocolFees } from '../data/fees';
import type { IndexedLoan } from '../data/indexer';
import { toRefinanceOfferPayload } from '../lib/offerSchema';
import {
  formatBpsAsPercent,
  formatTokenAmount,
  fullTermInterest,
} from '../lib/format';
import { ConfirmReceipt } from './ConfirmReceipt';
import type { TokenMeta } from '../contracts/erc20';

/** How long past the new-loan duration the caps' end-date window
 *  stretches — i.e. how long the posted request stays acceptable
 *  before the guardrail makes acceptance fail. Disclosed in the
 *  receipt's "when this ends" row. */
const REQUEST_WINDOW_DAYS = 30n;

function storageKey(chainId: number, loanId: number): string {
  return `alpha02.refinanceOffer.${chainId}.${loanId}`;
}
function readStoredOfferId(chainId: number, loanId: number): string | null {
  try {
    return window.localStorage.getItem(storageKey(chainId, loanId));
  } catch {
    return null;
  }
}
function writeStoredOfferId(
  chainId: number,
  loanId: number,
  offerId: string | null,
): void {
  try {
    if (offerId === null) window.localStorage.removeItem(storageKey(chainId, loanId));
    else window.localStorage.setItem(storageKey(chainId, loanId), offerId);
  } catch {
    // Private-browsing storage failures only cost the pending banner.
  }
}

export function RefinanceFlow({
  row,
  live,
  principalMeta,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
}: {
  row: IndexedLoan;
  live: LoanLive;
  principalMeta: TokenMeta;
  /** Page-wide single-confirm-surface slot (see PositionDetails). */
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
}) {
  const { address, walletChain, onSupportedChain, readChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const fees = useProtocolFees();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Defaults seed from the loan being replaced — the natural starting
  // point for "same loan, better terms".
  const [rateInput, setRateInput] = useState(
    () => String(Number(live.interestRateBps) / 100),
  );
  const [durationInput, setDurationInput] = useState(() =>
    String(row.durationDays),
  );
  const [consent, setConsent] = useState(false);
  // Local marker for the posted request; verified live below.
  const [pendingOfferId, setPendingOfferId] = useState<string | null>(() =>
    readStoredOfferId(readChain.chainId, row.loanId),
  );

  // Any term edit voids a previously ticked acknowledgement — the
  // page-wide consent rule (consent covers exactly what was reviewed).
  function setTerm(setter: (v: string) => void, value: string) {
    setter(value);
    setConsent(false);
    onCloseConfirm();
  }

  // ---- Pending request: live-verified, self-healing ----------------
  const pending = useQuery({
    queryKey: ['refinancePending', readChain.chainId, row.loanId, pendingOfferId],
    enabled: Boolean(readClient) && pendingOfferId !== null,
    refetchInterval: 30_000,
    queryFn: async () => {
      const offer = (await readClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getOfferDetails',
        args: [BigInt(pendingOfferId!)],
      })) as { creator: string; accepted: boolean; refinanceTargetLoanId: bigint };
      return {
        // cancelOffer DELETES the record — zeroed creator = gone.
        gone:
          offer.creator === '0x0000000000000000000000000000000000000000' ||
          offer.refinanceTargetLoanId !== BigInt(row.loanId),
        accepted: offer.accepted,
      };
    },
  });
  useEffect(() => {
    if (pending.data?.gone) {
      writeStoredOfferId(readChain.chainId, row.loanId, null);
      setPendingOfferId(null);
    }
  }, [pending.data?.gone, readChain.chainId, row.loanId]);

  // ---- Derived figures (display; submit re-reads live) -------------
  const remainingDays = interestRemainingDaysOf(live);
  const payoffInterest = fullTermInterest(
    live.principal,
    Number(live.interestRateBps),
    Number(remainingDays),
  );
  const payoff = live.principal + payoffInterest;
  const lifWei = (live.principal * BigInt(fees.loanInitiationFeeBps)) / 10_000n;
  // What the wallet must hold SPARE at accept: the payoff is pulled,
  // but the new principal minus LIF arrives in the same tx.
  const walletTopUp = payoffInterest + lifWei;

  const rateBps = isPositiveDecimal(rateInput)
    ? Math.round(parseFloat(rateInput) * 100)
    : null;
  const durationDays = /^\d+$/.test(durationInput)
    ? parseInt(durationInput, 10)
    : null;
  const durationValid =
    durationDays !== null &&
    durationDays >= 1 &&
    durationDays <= fees.maxOfferDurationDays;
  const rateValid = rateBps !== null && rateBps > 0 && rateBps <= 10_000;

  const sym = principalMeta.symbol;
  const dec = principalMeta.decimals;
  const payoffStr = `${formatTokenAmount(payoff, dec)} ${sym}`;
  const topUpStr = `${formatTokenAmount(walletTopUp, dec)} ${sym}`;

  async function submit() {
    if (!address || !walletChain || !walletClient || !publicClient) return;
    if (rateBps === null || durationDays === null) return;
    setBusy(true);
    setError(null);
    try {
      // createOffer + the accept-time refinance are Tier-1 — live
      // re-screen before anything can mine.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // Live state, one round-trip: current holdership (refinance
      // authority follows the borrower NFT), the loan itself (the
      // payload copies its collateral identity VERBATIM — stale
      // values would break carry-over), chain time, and the existing
      // guardrails.
      const [, liveLoan, latestBlock, caps] = await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.borrowerTokenId,
          expectedOwner: address,
        }),
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        publicClient.getBlock({ blockTag: 'latest' }),
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getAutoRefinanceCaps',
          args: [BigInt(row.loanId)],
        }) as Promise<{ enabled: boolean; maxRateBps: number; maxNewExpiry: bigint }>,
      ]);
      if (liveLoan.status !== LOAN_STATUS_ACTIVE) {
        setError(copy.errors.loanAlreadySettled);
        return;
      }
      const endTime = liveLoan.startTime + liveLoan.durationDays * 86_400n;
      if (latestBlock.timestamp >= endTime) {
        setError(copy.errors.refinanceMatured);
        return;
      }
      // Both legs paused-checked live — createOffer reverts on either.
      await Promise.all([
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: liveLoan.principalAsset,
        }),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: liveLoan.collateralAsset,
        }),
      ]);
      // Guardrails: rate ceiling = the reviewed rate; end-date window
      // = accept-time + duration must fit inside it, so the window is
      // duration + the disclosed request lifetime. Only (re)written
      // when the existing caps don't already cover the reviewed terms
      // — the OFFER's own rate ceiling is what binds the accept.
      const neededExpiry =
        latestBlock.timestamp +
        (BigInt(durationDays) + REQUEST_WINDOW_DAYS) * 86_400n;
      if (
        !caps.enabled ||
        Number(caps.maxRateBps) < rateBps ||
        caps.maxNewExpiry < neededExpiry
      ) {
        await write('setAutoRefinanceCaps', [
          BigInt(row.loanId),
          true,
          rateBps,
          neededExpiry,
        ]);
      }
      // Standing approval for the accept-time payoff pull — computed
      // from the LIVE loan. Exact, no pad: the pull is principal +
      // full-term interest on the REMAINING committed term, and both
      // components only shrink (partials reduce principal and settle
      // interest; time never grows the figure).
      const livePayoff =
        liveLoan.principal +
        fullTermInterest(
          liveLoan.principal,
          Number(liveLoan.interestRateBps),
          Number(interestRemainingDaysOf(liveLoan)),
        );
      // The approval itself needs no balance, but a wallet that can't
      // even cover the INTEREST portion today should hear it now, not
      // via a failed accept later. (The principal arrives in the
      // accept tx itself, so only the top-up is checked.)
      await assertErc20BalanceLive({
        publicClient,
        token: liveLoan.principalAsset,
        owner: address,
        amount:
          livePayoff - liveLoan.principal +
          (liveLoan.principal * BigInt(fees.loanInitiationFeeBps)) / 10_000n,
        symbol: sym,
      });
      await ensureAllowance({
        publicClient,
        walletClient,
        token: liveLoan.principalAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: livePayoff,
      });
      const payload = toRefinanceOfferPayload(liveLoan, row.loanId, {
        rateBpsMax: rateBps,
        durationDays,
        consent,
      });
      const { receipt } = await write('createOffer', [payload]);
      const created = parseEventLogs({
        abi: DIAMOND_ABI_VIEM,
        logs: receipt.logs,
        eventName: 'OfferCreated',
      }) as unknown as Array<{ args: { offerId: bigint } }>;
      const offerId = created[0]?.args.offerId;
      if (offerId !== undefined) {
        writeStoredOfferId(readChain.chainId, row.loanId, offerId.toString());
        setPendingOfferId(offerId.toString());
      }
      setDone(copy.refinance.done);
      setConsent(false);
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancelPending() {
    if (!pendingOfferId || !walletClient || !publicClient) return;
    setBusy(true);
    setError(null);
    try {
      await write('cancelOffer', [BigInt(pendingOfferId)]);
      writeStoredOfferId(readChain.chainId, row.loanId, null);
      setPendingOfferId(null);
      setDone(copy.refinance.cancelled);
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  // ---- Render -------------------------------------------------------
  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);

  return (
    <section className="card">
      <h3>{copy.refinance.title}</h3>
      <p className="muted">{copy.refinance.blurb}</p>

      {pendingOfferId !== null && !pending.data?.gone ? (
        // A live request exists — show its state instead of the form.
        <div>
          <div
            className={`banner ${pending.data?.accepted ? 'banner-info' : 'banner-warn'}`}
            role="status"
          >
            <span className="banner-body">
              {pending.data?.accepted
                ? copy.refinance.pendingAccepted
                : copy.refinance.pending(pendingOfferId)}{' '}
              {!pending.data?.accepted ? copy.refinance.walletNote(topUpStr) : null}
            </span>
          </div>
          {!pending.data?.accepted ? (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: 12 }}
              disabled={busy || !walletReady}
              onClick={() => void cancelPending()}
            >
              {copy.refinance.cancel}
            </button>
          ) : null}
        </div>
      ) : (
        <div>
          {live.periodicInterestCadence !== 0 ? (
            <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
              <span className="banner-body">{copy.refinance.periodicWarning}</span>
            </div>
          ) : null}
          <div className="cluster">
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">{copy.refinance.rateLabel}</span>
              <input
                className="input"
                inputMode="decimal"
                value={rateInput}
                onChange={(e) => setTerm(setRateInput, e.target.value.trim())}
                aria-label={copy.refinance.rateLabel}
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">{copy.refinance.durationLabel}</span>
              <input
                className="input"
                inputMode="numeric"
                value={durationInput}
                onChange={(e) => setTerm(setDurationInput, e.target.value.trim())}
                aria-label={copy.refinance.durationLabel}
              />
            </label>
          </div>
          {!durationValid && durationInput !== '' ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              Between 1 and {fees.maxOfferDurationDays} days.
            </p>
          ) : null}

          {!confirmOpen ? (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: 12 }}
              disabled={busy || !walletReady || !rateValid || !durationValid || !fees.ready}
              onClick={onOpenConfirm}
            >
              {copy.refinance.action}
            </button>
          ) : (
            <div style={{ marginTop: 16 }}>
              <label className="cluster" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  style={{ marginTop: 4 }}
                />
                <span>
                  I understand the payoff and wallet-balance terms below and
                  agree to them.
                </span>
              </label>
              <ConfirmReceipt
                busy={busy}
                confirmLabel={copy.refinance.confirm}
                onBack={onCloseConfirm}
                onConfirm={() => void submit()}
                disabled={!walletReady || !consent}
                data={{
                  youReceive:
                    'A new loan at your chosen terms the moment a lender accepts — your collateral moves to it automatically and this loan closes in the same transaction.',
                  youLock:
                    'Nothing new — your existing collateral carries over to the new loan without ever unlocking.',
                  youMayOwe: `~${payoffStr} to pay off this loan, pulled automatically when a lender accepts. ${copy.refinance.payoffNote} ${copy.refinance.walletNote(topUpStr)}`,
                  youCanLose: copy.refinance.shortIsSafe,
                  fees: `${copy.fees.borrowerLIF(formatBpsAsPercent(fees.loanInitiationFeeBps))} The protocol's ${formatBpsAsPercent(fees.treasuryFeeBps)} cut of the payoff interest settles inside the payoff.`,
                  whenThisEnds: `When a lender accepts your request — or you cancel it. ${copy.refinance.guardrailNote} The request stays acceptable for about ${Number(REQUEST_WINDOW_DAYS)} days; after that, acceptance fails safely and you can post a fresh one.`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {done ? (
        <div className="banner banner-info" role="status" style={{ marginTop: 12 }}>
          <span className="banner-body">{done}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}
