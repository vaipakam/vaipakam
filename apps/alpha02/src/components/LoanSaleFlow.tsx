/**
 * Lender Option-2 sale — list the position at the seller's own rate
 * (EarlyWithdrawalFacet.createLoanSaleOffer). A buyer accepting the
 * listing pays the seller the full outstanding principal and the
 * settlement (max of accrued-by-then or the rate shortfall) is
 * pulled from the SELLER's wallet inside the buyer's transaction —
 * so listing REQUIRES a standing approval sized to the bounded worst
 * case, and the pending card watches it (a short approval makes
 * every accept revert, invisibly).
 *
 * Listing LOCKS the lender position NFT (LockReason
 * EarlyWithdrawalSale) until the sale completes or the listing is
 * cancelled — disclosed before confirmation, per the FunctionalSpecs
 * lock-disclosure rule.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseEventLogs } from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, submitErrorText } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance } from '../contracts/erc20';
import {
  assertAssetNotPausedLive,
  assertPositionNftHeldLive,
} from '../contracts/preflights';
import {
  LOAN_STATUS_ACTIVE,
  readLoanLive,
  type LoanLive,
} from '../contracts/loanLive';
import { saleSettlementBound, saleSettlementNow } from '../data/loanSalePending';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import type { IndexedLoan } from '../data/indexer';
import { MAX_INTEREST_BPS, percentToBps } from '../lib/offerSchema';
import { formatTokenAmount } from '../lib/format';
import { ConfirmReceipt } from './ConfirmReceipt';
import type { TokenMeta } from '../contracts/erc20';

export function LoanSaleFlow({
  row,
  live,
  chainNow,
  principalMeta,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  onListed,
}: {
  row: IndexedLoan;
  live: LoanLive;
  chainNow: bigint;
  principalMeta: TokenMeta;
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** Hands the created listing's offer id to the page-owned state. */
  onListed: (offerId: string) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seed at the loan's own rate — the no-shortfall starting point.
  const [rateInput, setRateInput] = useState(
    () => String(Number(live.interestRateBps) / 100),
  );
  // Explicit risk-and-terms attestation — recorded on-chain on the
  // offer (creatorRiskAndTermsConsent), so it must be a real tick,
  // voided whenever the reviewed terms change.
  const [consent, setConsent] = useState(false);

  const rateBps = isPositiveDecimal(rateInput) ? percentToBps(rateInput) : null;
  const rateValid = rateBps !== null && rateBps > 0 && rateBps <= MAX_INTEREST_BPS;

  const sym = principalMeta.symbol;
  const dec = principalMeta.decimals;
  const bound =
    rateBps !== null
      ? saleSettlementBound(live, BigInt(rateBps), chainNow)
      : null;
  const nowCost =
    rateBps !== null ? saleSettlementNow(live, BigInt(rateBps), chainNow) : null;
  const boundStr =
    bound !== null ? `${formatTokenAmount(bound, dec)} ${sym}` : null;
  const principalStr = `${formatTokenAmount(live.principal, dec)} ${sym}`;

  // No review-void on the bound figure: it is quoted as an upper
  // bound ("up to X") and only SHRINKS between reviews (the padded
  // accrual leg is time-invariant; the shortfall leg decays), so a
  // 60s refetch tick must not keep collapsing an open review the
  // user is reading. Rate edits DO void it (below).

  async function submit() {
    if (!address || !walletChain || !walletClient || !publicClient) return;
    if (rateBps === null) return;
    setBusy(true);
    setError(null);
    try {
      // Tier-1 — the listing routes the buyer's principal to the
      // seller; re-screen live.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      const [, liveLoan, latestBlock] = await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.lenderTokenId,
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
      // createLoanSaleOffer reverts at/past maturity — fail plainly
      // before the wallet prompt.
      if (
        latestBlock.timestamp >=
        liveLoan.startTime + liveLoan.durationDays * 86_400n
      ) {
        setError(copy.errors.refinanceMatured);
        return;
      }
      // The standing settlement approval — full interest-window
      // accrual plus a re-accrual pad, or the shortfall if larger
      // (see saleSettlementBound; the pending card's watch + restore
      // cover a listing that outlives the pad). Set BEFORE the
      // listing exists so there is no window where a buyer's accept
      // reverts on a short allowance.
      const liveBound = saleSettlementBound(
        liveLoan,
        BigInt(rateBps),
        latestBlock.timestamp,
      );
      await ensureAllowance({
        publicClient,
        walletClient,
        token: liveLoan.principalAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: liveBound,
      });
      const { receipt } = await write('createLoanSaleOffer', [
        BigInt(row.loanId),
        rateBps,
        consent,
      ]);
      const linked = parseEventLogs({
        abi: DIAMOND_ABI_VIEM,
        logs: receipt.logs,
        eventName: 'LoanSaleOfferLinked',
      }) as unknown as Array<{ args: { saleOfferId: bigint } }>;
      const offerId = linked[0]?.args.saleOfferId;
      if (offerId !== undefined) onListed(offerId.toString());
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['loanSalePending'] });
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);

  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ marginBottom: 4 }}>{copy.loanSale.title}</h3>
      <p className="muted">{copy.loanSale.blurb}</p>
      <div className="cluster">
        <label className="field" style={{ flex: 1 }}>
          <span className="field-label">{copy.loanSale.rateLabel}</span>
          <input
            className="input"
            inputMode="decimal"
            value={rateInput}
            onChange={(e) => {
              setRateInput(e.target.value.trim());
              setConsent(false); // consent covers what was reviewed
              onCloseConfirm(); // edited terms void the open review
            }}
            aria-label={copy.loanSale.rateLabel}
          />
        </label>
      </div>
      {rateBps !== null && BigInt(rateBps) > live.interestRateBps ? (
        <p className="field-hint" style={{ marginTop: 8 }}>
          {copy.loanSale.sweetenNote}
        </p>
      ) : null}
      {!confirmOpen ? (
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginTop: 12 }}
          disabled={busy || !walletReady || !rateValid}
          onClick={onOpenConfirm}
        >
          {copy.loanSale.action}
        </button>
      ) : boundStr && nowCost !== null ? (
        <div style={{ marginTop: 16 }}>
          <label className="cluster" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              style={{ marginTop: 4 }}
            />
            <span>
              I understand the lock, the settlement pull, and the standing
              approval below and agree to them.
            </span>
          </label>
          <ConfirmReceipt
            busy={busy}
            confirmLabel={copy.loanSale.confirm}
            onBack={onCloseConfirm}
            onConfirm={() => void submit()}
            disabled={!walletReady || !consent}
            data={{
              youReceive: `${principalStr} — the full outstanding amount, paid to your wallet the moment a buyer accepts.`,
              youLock:
                'Your lender position NFT, until the sale completes or you cancel the listing. Nothing else.',
              youMayOwe: `At acceptance, the settlement is pulled from your wallet: the LARGER of the interest accrued by then or the rate difference for the remaining term — never both. Right now that would be ~${formatTokenAmount(nowCost, dec)} ${sym}. ${copy.loanSale.approvalNote(boundStr)}`,
              youCanLose:
                'If your balance or the standing approval goes short, a buyer’s acceptance simply fails — nothing is taken, but the listing sits unfillable until you restore it or cancel.',
              fees: 'The protocol’s cut comes out of the settlement figure — nothing beyond it.',
              whenThisEnds:
                'When a buyer accepts (everything settles in their transaction) or when you cancel the listing. It does not expire on its own.',
            }}
          >
            <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
              <span className="banner-body">{copy.loanSale.lockWarning}</span>
            </div>
          </ConfirmReceipt>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </div>
  );
}
