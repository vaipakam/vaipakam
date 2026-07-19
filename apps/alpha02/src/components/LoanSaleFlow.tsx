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
/**
 * Feature gate — issue #951: the cross-facet reentrancy bug that made
 * every `createLoanSaleOffer` revert was fixed in #959 and CUT into
 * the Base Sepolia + Arb Sepolia Diamonds on 2026-07-04
 * (CatchUpFacetCut959.s.sol). Verified live before enabling:
 * `createLoanSaleOffer` simulates cleanly on an active loan against
 * the post-cut Diamond (it was ReentrancyGuardReentrantCall before).
 *
 * PER-CHAIN on purpose: on a chain WITHOUT the cut (e.g. BNB Testnet,
 * still in the deployments bundle) the flow would mine the standing
 * settlement approval and only THEN hit the old reverting listing
 * call — gas burned, best-effort revoke. Add a chain here only after
 * running the catch-up cut on it and re-verifying the simulation.
 */
const LOAN_SALE_LISTING_CHAINS: ReadonlySet<number> = new Set([
  84532, // Base Sepolia — #959 cut 2026-07-04, sim-verified
  421614, // Arb Sepolia — #959 cut 2026-07-04, loupe-verified
]);
export function loanSaleListingEnabled(chainId: number): boolean {
  return LOAN_SALE_LISTING_CHAINS.has(chainId);
}
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { encodeFunctionData, parseEventLogs } from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, captureTxError } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance, revokeAllowance } from '../contracts/erc20';
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
import { SimulationPreview } from './SimulationPreview';
import type { TxSimInput } from '../contracts/useTxSimulation';
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
  busy,
  setBusy,
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
  /** SHARED lender-block write lock (also held by the instant-exit
   *  card): two exits racing each other would grant the standing
   *  approval and then revert the listing when the other sale mines. */
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();

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

  // #1028 item 2 — advisory pre-sign dry run of the exact listing
  // calldata. All three args exist pre-sign; built only once consent
  // is ticked (the contract checks it, and previewing consent=false
  // would just show that revert). NO allowance downgrade here (round
  // 1): the listing tx itself neither reads nor spends the standing
  // settlement allowance — that approval serves a LATER buyer
  // acceptance, is granted alongside the listing, and is disclosed
  // by the receipt's approvalNote — so a "passed" verdict is
  // accurate for what this signature actually sends.
  const simTx = useMemo((): TxSimInput | null => {
    if (!walletChain || rateBps === null || !rateValid || !consent) return null;
    return {
      to: walletChain.diamondAddress,
      data: encodeFunctionData({
        abi: DIAMOND_ABI_VIEM,
        functionName: 'createLoanSaleOffer',
        args: [BigInt(row.loanId), rateBps, consent],
      }),
      value: 0n,
    };
  }, [walletChain, rateBps, rateValid, consent, row.loanId]);

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
    // #1028 — a sale listing creates and locks a NEW offer: it rides
    // the same kill switch as the other offer-creating paths.
    // (Optional acceleration — blocking it traps nothing; the lender
    // keeps normal maturity/claim paths.)
    if (flowDisabled('post-offer')) {
      setError(copy.killSwitch.disabled);
      return;
    }
    if (!address || !walletChain || !walletClient || !publicClient) return;
    if (rateBps === null) return;
    setBusy(true);
    setError(null);
    // Tracks whether THIS attempt granted the settlement approval, so
    // an abandoned/reverted listing step can unwind it (no dangling
    // payoff-sized authorization behind a pristine form).
    let approvalGranted = false;
    let approvalToken: `0x${string}` | null = null;
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
        setError(copy.errors.saleListingMatured);
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
      // Only a MINED approve tx arms the unwind — when the wallet
      // already held a sufficient allowance (ensureAllowance returns
      // null), that allowance belongs to some other live arrangement
      // (a pending refinance, a user-managed grant) and a failed
      // listing step must not zero it out from under that flow.
      const approvalTx = await ensureAllowance({
        publicClient,
        walletClient,
        token: liveLoan.principalAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: liveBound,
      });
      approvalGranted = approvalTx !== null;
      approvalToken = liveLoan.principalAsset;
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
      setError(captureTxError(err));
      // The listing never landed but the settlement approval mined —
      // best-effort unwind (mirrors the refinance flow's rule): a
      // second rejection just leaves the wallet's approvals view as
      // the remedy, with the error banner already showing.
      if (approvalGranted && approvalToken) {
        try {
          await revokeAllowance({
            publicClient,
            walletClient,
            token: approvalToken,
            owner: address,
            spender: walletChain.diamondAddress,
          });
        } catch {
          // Leave the submit error as the surfaced failure.
        }
      }
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
      {/* #1028 — kill switch held up front like the other gated flows. */}
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
          disabled={busy || !walletReady || !rateValid || flowDisabled('post-offer')}
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
            <span>{copy.loanSale.consentLabel}</span>
          </label>
          <ConfirmReceipt
            busy={busy}
            confirmLabel={copy.loanSale.confirm}
            onBack={onCloseConfirm}
            onConfirm={() => void submit()}
            disabled={!walletReady || !consent || flowDisabled('post-offer')}
            data={{
              youReceive: copy.loanSale.receiptYouReceive(principalStr),
              youLock: copy.loanSale.receiptLock,
              youMayOwe: `${copy.loanSale.receiptYouMayOwe(formatTokenAmount(nowCost, dec), sym)} ${copy.loanSale.approvalNote(boundStr)}`,
              youCanLose: copy.loanSale.receiptCanLose,
              fees: copy.loanSale.receiptFees,
              whenThisEnds: copy.loanSale.receiptEnds,
            }}
          >
            <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
              <span className="banner-body">{copy.loanSale.lockWarning}</span>
            </div>
            <SimulationPreview tx={simTx} />
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
