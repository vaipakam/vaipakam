/**
 * Borrower preclose Option 3 — offset: fund a NEW lender offer on the
 * same assets, pinned to this loan (PrecloseFacet.offsetWithNewOffer).
 * When a counterparty borrower accepts the linked offer, the diamond
 * completes the offset ATOMICALLY inside that acceptance: the old
 * lender is paid principal + accrued + rate top-up (pulled from this
 * borrower's wallet via the standing approval granted here), the old
 * loan closes, and the poster carries on as the new loan's lender.
 *
 * Nothing is settled at posting (Codex #1070 redesign) — posting only
 * escrows the NEW offer's lending money (loan.principal, pulled by
 * createOffer) and transfer-locks the borrower position NFT. Both are
 * MUST-SURFACE disclosures (contract doc): the lock note renders on
 * the form AND the review, and the funding note quotes both figures.
 *
 * The pending offset's standing surface is the page-owned
 * OffsetPendingCard (driven by useOffsetPending) — a live offset must
 * outlive this card's mount gates.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseEventLogs, parseUnits } from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, captureTxError } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance } from '../contracts/erc20';
import {
  assertAssetNotPausedLive,
  assertErc20BalanceLive,
  assertPositionNftHeldLive,
} from '../contracts/preflights';
import {
  loanEndTimeOf,
  LOAN_STATUS_ACTIVE,
  offsetCompletionBoundOf,
  readLoanLive,
  type LoanLive,
} from '../contracts/loanLive';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import type { IndexedLoan } from '../data/indexer';
import { MAX_INTEREST_BPS, percentToBps } from '../lib/offerSchema';
import { exactAmountString, formatTokenAmount } from '../lib/format';
import { ConfirmReceipt } from './ConfirmReceipt';
import type { TokenMeta } from '../contracts/erc20';

export function OffsetFlow({
  row,
  live,
  chainNow,
  principalMeta,
  collateralMeta,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  onPosted,
  busy,
  setBusy,
}: {
  row: IndexedLoan;
  live: LoanLive;
  /** Chain time from the parent's live query — never the device clock. */
  chainNow: bigint;
  principalMeta: TokenMeta;
  /** Undefined for NFT collateral — the flow then repeats the loan's
   *  collateral identity verbatim with no editable amount. */
  collateralMeta: TokenMeta | undefined;
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** Hands the created offer id to the page-owned pending state. */
  onPosted: (offerId: string) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Defaults seed from the loan being offset — the natural starting
  // point ("replace my loan like-for-like").
  const [rateInput, setRateInput] = useState(
    () => String(Number(live.interestRateBps) / 100),
  );
  // The replacement term must END no later than the original maturity
  // (seconds-precise on-chain; whole days here rounds DOWN, so the
  // default always fits).
  const maxDurationDays = (() => {
    const end = loanEndTimeOf(live);
    return end > chainNow ? (end - chainNow) / 86_400n : 0n;
  })();
  const [durationInput, setDurationInput] = useState(() =>
    String(maxDurationDays),
  );
  // exactAmountString, not formatTokenAmount: the display formatter's
  // thousands separators don't parse back through parseUnits.
  const [collateralInput, setCollateralInput] = useState(() =>
    collateralMeta
      ? exactAmountString(live.collateralAmount, collateralMeta.decimals)
      : '',
  );
  const [consent, setConsent] = useState(false);

  // Any term edit voids a previously ticked acknowledgement — the
  // page-wide consent rule (consent covers exactly what was reviewed).
  function setTerm(setter: (v: string) => void, value: string) {
    setter(value);
    setConsent(false);
    onCloseConfirm();
  }

  const rateBps = isPositiveDecimal(rateInput) ? percentToBps(rateInput) : null;
  const rateValid = rateBps !== null && rateBps > 0 && rateBps <= MAX_INTEREST_BPS;
  const durationDays = /^\d+$/.test(durationInput)
    ? parseInt(durationInput, 10)
    : null;
  const durationValid =
    durationDays !== null &&
    durationDays >= 1 &&
    BigInt(durationDays) <= maxDurationDays;
  const collateralIsNft = collateralMeta === undefined;
  const collateralWei = (() => {
    if (collateralIsNft) return live.collateralAmount;
    if (!isPositiveDecimal(collateralInput)) return null;
    try {
      return parseUnits(collateralInput, collateralMeta.decimals);
    } catch {
      return null;
    }
  })();
  const collateralValid =
    collateralWei !== null && collateralWei >= live.collateralAmount;

  const dec = principalMeta.decimals;
  const sym = principalMeta.symbol;
  const principalStr = `${formatTokenAmount(live.principal, dec)} ${sym}`;
  const completionBound = offsetCompletionBoundOf(live);
  const completionStr = `${formatTokenAmount(completionBound, dec)} ${sym}`;

  // The consent rule covers the FIGURES too — the live-loan prop
  // refreshes in the background, and a tick given against old numbers
  // must not survive.
  useEffect(() => {
    setConsent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principalStr, completionStr]);

  async function submit() {
    // The offset IS a createOffer — same kill switch as the direct
    // post path during an OfferFacet incident.
    if (flowDisabled('post-offer')) {
      setError(copy.killSwitch.disabled);
      return;
    }
    if (!address || !walletChain || !walletClient || !publicClient) return;
    if (rateBps === null || durationDays === null || collateralWei === null)
      return;
    setBusy(true);
    setError(null);
    try {
      // offsetWithNewOffer is Tier-1 — live re-screen before anything
      // can mine.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      const [, liveLoan, latestBlock] = await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.borrowerTokenId,
          expectedOwner: address,
        }),
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        publicClient.getBlock({ blockTag: 'latest' }),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: row.lendingAsset as `0x${string}`,
        }),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: row.collateralAsset as `0x${string}`,
        }),
      ]);
      if (liveLoan.status !== LOAN_STATUS_ACTIVE) {
        setError(copy.errors.loanAlreadySettled);
        return;
      }
      // Re-judge the term bound by LIVE chain time — the reviewed
      // duration can stop fitting while the receipt sits open.
      if (
        latestBlock.timestamp + BigInt(durationDays) * 86_400n >
        loanEndTimeOf(liveLoan)
      ) {
        setError(copy.offset.onlyBeforeDue);
        return;
      }
      if (collateralWei < liveLoan.collateralAmount) {
        setError(
          copy.offset.collateralMin(
            collateralMeta
              ? formatTokenAmount(
                  liveLoan.collateralAmount,
                  collateralMeta.decimals,
                )
              : String(liveLoan.collateralAmount),
          ),
        );
        return;
      }
      // Posting pulls the NEW offer's escrow (= the loan's live
      // principal) from the wallet NOW; completion later pulls up to
      // the completion bound. One approval covers both legs; the
      // balance check covers only today's pull (the funding note +
      // pending-card watch own the completion figure).
      const liveBound = offsetCompletionBoundOf(liveLoan);
      await assertErc20BalanceLive({
        publicClient,
        token: liveLoan.principalAsset,
        owner: address,
        amount: liveLoan.principal,
        symbol: sym,
      });
      await ensureAllowance({
        publicClient,
        walletClient,
        token: liveLoan.principalAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: liveLoan.principal + liveBound,
      });
      const { receipt } = await write('offsetWithNewOffer', [
        BigInt(row.loanId),
        BigInt(rateBps),
        BigInt(durationDays),
        liveLoan.collateralAsset,
        collateralWei,
        consent,
        liveLoan.prepayAsset,
      ]);
      const created = parseEventLogs({
        abi: DIAMOND_ABI_VIEM,
        logs: receipt.logs,
        eventName: 'OffsetOfferCreated',
      }) as unknown as Array<{ args: { newOfferId: bigint } }>;
      const offerId = created[0]?.args.newOfferId;
      if (offerId !== undefined) onPosted(offerId.toString());
      setDone(copy.offset.done);
      setConsent(false);
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['offsetPending'] });
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);

  // No fitting replacement term exists this close to (or past) the
  // due date — say so instead of rendering a form that can't submit.
  if (maxDurationDays < 1n) {
    return (
      <section className="card" id="offset-card">
        <h3>{copy.offset.title}</h3>
        <p className="muted">{copy.offset.onlyBeforeDue}</p>
      </section>
    );
  }

  return (
    <section className="card" id="offset-card">
      <h3>{copy.offset.title}</h3>
      <p className="muted">{copy.offset.blurb}</p>

      <div className="banner banner-warn" role="note" style={{ marginBottom: 12 }}>
        <span className="banner-body">{copy.offset.lockWarn}</span>
      </div>

      <div className="cluster">
        <label className="field" style={{ flex: 1 }}>
          <span className="field-label">{copy.offset.rateLabel}</span>
          <input
            className="input"
            inputMode="decimal"
            value={rateInput}
            onChange={(e) => setTerm(setRateInput, e.target.value.trim())}
            aria-label={copy.offset.rateLabel}
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span className="field-label">{copy.offset.durationLabel}</span>
          <input
            className="input"
            inputMode="numeric"
            value={durationInput}
            onChange={(e) => setTerm(setDurationInput, e.target.value.trim())}
            aria-label={copy.offset.durationLabel}
          />
        </label>
      </div>
      {!durationValid && durationInput !== '' ? (
        <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
          {copy.offset.durationMax(String(maxDurationDays))}
        </p>
      ) : null}
      {!collateralIsNft ? (
        <label className="field" style={{ marginTop: 8 }}>
          <span className="field-label">
            {copy.offset.collateralLabel(collateralMeta!.symbol)}
          </span>
          <input
            className="input"
            inputMode="decimal"
            value={collateralInput}
            onChange={(e) => setTerm(setCollateralInput, e.target.value.trim())}
            aria-label={copy.offset.collateralLabel(collateralMeta!.symbol)}
          />
          {!collateralValid && collateralInput !== '' ? (
            <span className="field-hint" style={{ color: 'var(--danger)' }}>
              {copy.offset.collateralMin(
                formatTokenAmount(
                  live.collateralAmount,
                  collateralMeta!.decimals,
                ),
              )}
            </span>
          ) : null}
        </label>
      ) : null}

      <p className="muted" style={{ marginTop: 12 }}>
        {copy.offset.fundsNote(principalStr, completionStr)}
      </p>

      {flowDisabled('post-offer') ? (
        <div className="banner banner-warn" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{copy.killSwitch.disabled}</span>
        </div>
      ) : null}
      {!confirmOpen ? (
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginTop: 12 }}
          disabled={
            busy ||
            !walletReady ||
            !rateValid ||
            !durationValid ||
            !collateralValid ||
            flowDisabled('post-offer')
          }
          onClick={onOpenConfirm}
        >
          {copy.offset.action}
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
            <span>{copy.offset.consentLabel}</span>
          </label>
          <ConfirmReceipt
            busy={busy}
            confirmLabel={copy.offset.confirm}
            onBack={onCloseConfirm}
            onConfirm={() => void submit()}
            disabled={!walletReady || !consent || flowDisabled('post-offer')}
            data={{
              youReceive: copy.offset.receiptReceive,
              youLock: copy.offset.receiptLock(principalStr),
              youMayOwe: copy.offset.receiptOwe(completionStr),
              youCanLose: copy.offset.receiptLose,
              fees: copy.offset.receiptFees,
              whenThisEnds: copy.offset.receiptEnds,
            }}
          >
            <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
              <span className="banner-body">{copy.offset.lockWarn}</span>
            </div>
          </ConfirmReceipt>
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
