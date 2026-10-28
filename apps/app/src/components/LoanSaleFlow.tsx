/**
 * Lender Option-2 sale — list the position at the seller's own rate
 * (EarlyWithdrawalFacet.createLoanSaleOfferBound, #1810). A buyer accepting the
 * listing pays the outstanding principal into escrow, and the completion in
 * the same transaction deducts the settlement (the larger of the interest the
 * seller gives up and the rate top-up owed to the buyer) before paying the
 * rest to the seller (net settlement, #1659). Nothing is drawn from the
 * seller's wallet, so listing asks for no token approval (#2674).
 *
 * Listing LOCKS the lender position NFT (LockReason
 * EarlyWithdrawalSale) until the sale completes or the listing is
 * cancelled — disclosed before confirmation, per the FunctionalSpecs
 * lock-disclosure rule.
 *
 * #1810 — the listing records a guaranteed minimum for the seller and a
 * ceiling on what is already set aside for the lender. Both are quoted from
 * the chain (`data/sellerBoundsQuote.ts`) and shown before the seller
 * agrees, and the listing is sent BOUND to the figures reviewed, so the chain
 * refuses it rather than record worse ones (a partial repayment, or time
 * passing, between the review and the listing transaction).
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
 * still in the deployments bundle) every listing would be refused. Add a
 * chain here only after running the catch-up cut on it and re-verifying the
 * simulation.
 *
 * #1810 adds two selectors the flow now needs on the same chains:
 * `quoteSellerBounds` and `createLoanSaleOfferBound`. Both were loupe-checked
 * as routed on Base Sepolia and Arb Sepolia on 2026-10-23; a chain added here
 * must route them too.
 */
const LOAN_SALE_LISTING_CHAINS: ReadonlySet<number> = new Set([
  84532, // Base Sepolia — #959 cut 2026-07-04, sim-verified
  421614, // Arb Sepolia — #959 cut 2026-07-04, loupe-verified
]);
export function loanSaleListingEnabled(chainId: number): boolean {
  return LOAN_SALE_LISTING_CHAINS.has(chainId);
}
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { encodeFunctionData, parseEventLogs } from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, captureTxError } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite, useTermsBlockNonExitWrites } from '../contracts/diamond';
import { loanEndTimeOf, type LoanLive } from '../contracts/loanLive';
import { saleSettlementNow } from '../data/loanSalePending';
import {
  readSellerBoundsQuote,
  type SellerBoundsQuote,
} from '../data/sellerBoundsQuote';
import {
  boundListingArgs,
  checkSaleListing,
  reviewedBoundsMoved,
} from '../data/saleListingPlan';
import type { IndexedLoan } from '../data/indexer';
import { MAX_INTEREST_BPS, percentToBps } from '../lib/offerSchema';
import { formatTokenAmountExact } from '../lib/format';
import { ConfirmReceipt } from './ConfirmReceipt';
import { useReviewConsent } from '../hooks/useReviewConsent';
import { ConsentWithdrawnNote } from './ConsentWithdrawnNote';
import { SimulationPreview } from './SimulationPreview';
import type { TxSimInput } from '../contracts/useTxSimulation';
import type { TokenMeta } from '../contracts/erc20';

export function LoanSaleFlow({
  row,
  live,
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
  principalMeta: TokenMeta;
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** Hands the created listing's offer id to the page-owned state. */
  onListed: (offerId: string) => void;
  /** SHARED lender-block write lock (also held by the instant-exit
   *  card): two exits racing each other would revert the listing when
   *  the other sale mines. */
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const termsVerdict = useTermsBlockNonExitWrites();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  // Seed at the loan's own rate — the no-shortfall starting point.
  const [rateInput, setRateInput] = useState(
    () => String(Number(live.interestRateBps) / 100),
  );
  // Mandatory finite listing window (LenderEarlyWithdrawalUXDesign item 1):
  // the seller picks a duration; there is no never-expires option. The
  // contract bounds it to [1 hour, 30 days] and additionally clamps the
  // resulting expiry at the loan's own maturity.
  const [listingDays, setListingDays] = useState(7);
  const listingSeconds = BigInt(listingDays) * 86400n;

  const rateBps = isPositiveDecimal(rateInput) ? percentToBps(rateInput) : null;
  const rateValid = rateBps !== null && rateBps > 0 && rateBps <= MAX_INTEREST_BPS;

  // #1810 — the seller's guaranteed minimum and the held ceiling, quoted live
  // for the rate and window on the form. Refreshed while the form is open
  // because the floor drifts down as interest builds; the review then FREEZES
  // the figures it shows (`reviewed`), since those are what the listing is
  // bound to.
  const maturity = loanEndTimeOf(live);
  const quote = useQuery({
    queryKey: [
      'sellerBoundsQuote',
      walletChain?.chainId,
      row.loanId,
      rateBps,
      listingSeconds.toString(),
      maturity.toString(),
    ],
    enabled: Boolean(publicClient) && Boolean(walletChain) && rateValid,
    refetchInterval: 60_000,
    queryFn: () =>
      readSellerBoundsQuote(publicClient!, walletChain!.diamondAddress, {
        loanId: row.loanId,
        saleRateBps: BigInt(rateBps!),
        listingSeconds,
        maturity,
      }),
  });
  // A quote is usable only while it is current: a failed refresh keeps the
  // previous figures in `data`, and those no longer describe the listing.
  const liveQuote: SellerBoundsQuote | null =
    quote.data !== undefined && !quote.isError ? quote.data : null;
  const [reviewed, setReviewed] = useState<SellerBoundsQuote | null>(null);

  // An unavailable QUOTE must not take the listing surface with it (Codex
  // #1801 r10 P2). `readLoanLive` deliberately still resolves when the optional
  // window read fails, and `sellerEconomics` throws rather than substituting a
  // number — but these two calls run at RENDER time, outside any handler or
  // boundary, so opening Position Details would lose the whole form instead of
  // showing an unavailable quote.
  //
  // Same guard EarlyExitFlow got in r8; this component is its sibling and I
  // fixed only the one the finding named.
  const quoteUnavailable = live.lenderForfeitFrom === undefined;
  const nowCost =
    rateBps !== null && !quoteUnavailable
      ? saleSettlementNow(live, BigInt(rateBps))
      : null;

  // Explicit risk-and-terms attestation — recorded on-chain on the offer
  // (creatorRiskAndTermsConsent), so it must be a real tick, voided whenever
  // the reviewed terms change: the rate and window the user set, the figures
  // frozen with the review, and today's settlement cost, which moves with
  // the live loan. Keyed on the values and cleared in the same render
  // (#1696).
  const consent = useReviewConsent([
    row.loanId,
    rateBps,
    listingSeconds,
    reviewed?.minSellerNet,
    reviewed?.maxHeld,
    nowCost,
    principalMeta.symbol,
    principalMeta.decimals,
    address,
    walletChain?.chainId,
  ]);

  // #1028 item 2 — advisory pre-sign dry run of the exact listing
  // calldata. All its args exist pre-sign; built only once consent
  // is ticked (the contract checks it, and previewing consent=false
  // would just show that revert). The listing needs no approval, so a
  // "passed" verdict is accurate for what this signature sends.
  // Not memoized: the simulation keys on the calldata, not on the object.
  const boundListingTx = ((): TxSimInput | null => {
    if (!walletChain || rateBps === null || !rateValid || !reviewed) {
      return null;
    }
    return {
      to: walletChain.diamondAddress,
      data: encodeFunctionData({
        abi: DIAMOND_ABI_VIEM,
        functionName: 'createLoanSaleOfferBound',
        args: boundListingArgs(row.loanId, { rateBps, listingSeconds }, reviewed),
      }),
      value: 0n,
    };
  })();
  // Previewed with consent `true`, which is the only value it is ever
  // shown for.
  const simTx = consent.given ? boundListingTx : null;

  const sym = principalMeta.symbol;
  const dec = principalMeta.decimals;

  // ONE way into the review and one way out of a stale one (Codex #2673 r1).
  // Consent always covers exactly the figures frozen with it, so opening a
  // review clears it. A stale review also drops the cached quote — the
  // figures that just failed — so Review stays unavailable until the current
  // figures have been read, rather than re-offering the same refusal.
  function openReview(q: SellerBoundsQuote) {
    consent.clear();
    setReviewed(q);
    onOpenConfirm();
  }

  function closeStaleReview() {
    consent.clear();
    setReviewed(null);
    onCloseConfirm();
    void queryClient.resetQueries({
      queryKey: ['sellerBoundsQuote', walletChain?.chainId, row.loanId],
    });
  }

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
    if (rateBps === null || !reviewed || !consent.given) return;
    // #1961 — this flow lives on `/positions/:loanId`, which the Terms gate
    // exempts so a held user can repay; the listing is NOT an exit, so
    // `useDiamondWrite` would refuse it at submission. Say so before the
    // live reads rather than after them.
    const termsForFlow = termsVerdict();
    if (termsForFlow !== 'ok') {
      setError(
        termsForFlow === 'unknown'
          ? copy.errors.termsCheckUnavailable
          : copy.errors.termsNotAccepted,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The live checks a listing runs before it is signed, bound to the
      // figures the seller reviewed — one copy, shared with the batch
      // listing on Positions (#126).
      const refusal = await checkSaleListing(
        { publicClient, diamond: walletChain.diamondAddress, holder: address },
        row,
        { rateBps, listingSeconds },
        reviewed,
      );
      if (refusal) {
        // The reviewed figures no longer hold: close the review so the next
        // one shows the current figures; the error says why.
        if (refusal.boundsMoved) closeStaleReview();
        setError(refusal.reason);
        return;
      }
      const { receipt } = await write(
        'createLoanSaleOfferBound',
        boundListingArgs(row.loanId, { rateBps, listingSeconds }, reviewed),
      );
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
      // Mined after the reviewed figures stopped holding (the transaction
      // took longer than the quote allows, or the loan moved meanwhile).
      if (reviewedBoundsMoved(err)) closeStaleReview();
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
              setReviewed(null);
              onCloseConfirm(); // edited terms void the open review
            }}
            aria-label={copy.loanSale.rateLabel}
          />
        </label>
        <label className="field">
          <span className="field-label">{copy.loanSale.windowLabel}</span>
          <select
            className="input"
            value={listingDays}
            onChange={(e) => {
              setListingDays(Number(e.target.value));
              setReviewed(null);
              onCloseConfirm(); // edited terms void the open review
            }}
            aria-label={copy.loanSale.windowLabel}
          >
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {copy.loanSale.windowOption(d)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="field-hint" style={{ marginTop: 8 }}>
        {copy.loanSale.windowNote}
      </p>
      {/* #1810 — the guaranteed minimum for THIS rate and window, read live. */}
      {rateValid ? (
        liveQuote ? (
          <>
            <p className="field-hint" style={{ marginTop: 8 }}>
              {copy.loanSale.floorQuote(formatTokenAmountExact(liveQuote.minSellerNet, dec), sym)}
            </p>
            {liveQuote.maxHeld > 0n ? (
              <p className="field-hint" style={{ marginTop: 8 }}>
                {copy.loanSale.heldQuote(formatTokenAmountExact(liveQuote.maxHeld, dec), sym)}
              </p>
            ) : null}
          </>
        ) : quote.isError ? (
          <div className="banner banner-warn" role="alert" style={{ marginTop: 8 }}>
            <span className="banner-body">{copy.loanSale.floorUnavailable}</span>
          </div>
        ) : (
          <p className="field-hint" style={{ marginTop: 8 }}>
            {copy.loanSale.floorLoading}
          </p>
        )
      ) : null}
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
          disabled={
            busy ||
            !walletReady ||
            !rateValid ||
            quoteUnavailable ||
            !liveQuote ||
            flowDisabled('post-offer')
          }
          onClick={() => {
            // The review shows, and the listing is bound to, the figures on
            // screen at this moment.
            if (liveQuote) openReview(liveQuote);
          }}
        >
          {copy.loanSale.action}
        </button>
      ) : nowCost !== null && reviewed ? (
        <div style={{ marginTop: 16 }}>
          <label className="cluster" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={consent.given}
              onChange={(e) => consent.set(e.target.checked)}
              style={{ marginTop: 4 }}
            />
            <span>{copy.loanSale.consentLabel}</span>
          </label>
          <ConsentWithdrawnNote consent={consent} />
          <ConfirmReceipt
            busy={busy}
            confirmLabel={copy.loanSale.confirm}
            onBack={onCloseConfirm}
            onConfirm={() => void submit()}
            disabled={!walletReady || !consent.given || quoteUnavailable || flowDisabled('post-offer')}
            data={{
              youReceive: [
                copy.loanSale.receiptFloor(formatTokenAmountExact(reviewed.minSellerNet, dec), sym),
                reviewed.maxHeld > 0n
                  ? copy.loanSale.heldQuote(formatTokenAmountExact(reviewed.maxHeld, dec), sym)
                  : null,
              ]
                .filter(Boolean)
                .join(' '),
              youLock: copy.loanSale.receiptLock,
              youMayOwe: copy.loanSale.receiptYouMayOwe(formatTokenAmountExact(nowCost, dec), sym),
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
