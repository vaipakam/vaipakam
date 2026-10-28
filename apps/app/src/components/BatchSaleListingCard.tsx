/**
 * List every lender position that came from one offer for sale, on the
 * same terms (#126 slice 2).
 *
 * One rate and one listing window for the whole group. Every loan is
 * planned through the same live checks its own page's listing form runs
 * (`saleListingPlan.ts`), and each listing is BOUND to the minimum and the
 * held ceiling quoted for it and shown in the review (#1810); a loan with
 * nothing to list, or whose figures no longer hold, is left out and named.
 * The listings go to the Diamond's `multicall`, up to 30 per transaction,
 * each running as the lender with `allowFailure`, so a listing that fails
 * at execution is skipped while the others list.
 *
 * A listing draws nothing from the wallet and asks for no approval
 * (#2674); it LOCKS each listed position NFT, which the review discloses
 * before the consent is given.
 *
 * Which loans were listed is read from the transaction's own logs, never
 * assumed from its status (`batchSale.ts`).
 */
import { useState, type ReactNode } from 'react';
import { LoaderCircle, Store } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite, useTermsBlockNonExitWrites } from '../contracts/diamond';
import { useTokenMeta } from '../contracts/erc20';
import { captureTxError, isPositiveDecimal } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { formatTokenAmountExact } from '../lib/format';
import { MAX_INTEREST_BPS, percentToBps } from '../lib/offerSchema';
import type { PositionLoan } from '../data/hooks';
import { settleFailedSend, type Mined, type OfferGroup } from '../data/batchCloseOut';
import { chunkForMulticall, encodeBestEffort } from '../data/multicall';
import {
  boundListingArgs,
  planSaleListingForBatch,
  type SaleListingCtx,
  type SaleListingPlan,
  type SaleListingTerms,
} from '../data/saleListingPlan';
import { readBackListings, type SaleBatchOutcome } from '../data/batchSale';
import { rememberLoanSaleOffer } from '../data/loanSalePending';
import { useReviewConsent } from '../hooks/useReviewConsent';
import { ConfirmReceipt } from './ConfirmReceipt';
import { ConsentWithdrawnNote } from './ConsentWithdrawnNote';

type ReadyPlan = Extract<SaleListingPlan, { kind: 'ready' }>;

type Stage =
  | { kind: 'idle' }
  | { kind: 'planning' }
  | { kind: 'review'; terms: SaleListingTerms; plans: SaleListingPlan[] }
  | { kind: 'sending'; step: 'checking' | 'submitting' }
  | { kind: 'done'; outcomes: SaleBatchOutcome[] };

/** The listing windows the loan page offers, in days. */
const WINDOW_DAYS = [1, 3, 7, 14, 30] as const;

/** What the consent covers: the terms and every figure and statement the
 *  review shows, so any change to them clears the tick. */
function reviewFingerprint(stage: Stage): string {
  if (stage.kind !== 'review') return stage.kind;
  return JSON.stringify(
    {
      rate: stage.terms.rateBps,
      window: stage.terms.listingSeconds,
      plans: stage.plans,
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
}

export function BatchSaleListingCard({
  group,
  onHeldChange,
}: {
  group: OfferGroup<PositionLoan>;
  /** Told when the card starts a batch (true) and when its results are
   *  dismissed (false), so the page keeps it mounted in between. */
  onHeldChange?: (group: OfferGroup<PositionLoan>, held: boolean) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();
  const { write } = useDiamondWrite();
  const termsVerdict = useTermsBlockNonExitWrites();
  const meta = useTokenMeta(group.loans[0]?.lendingAsset);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  // Seeded at the first loan's rate: the loans from one offer start on its
  // rate, and each loan's review line says when the chosen rate is above
  // that loan's own.
  const [rateInput, setRateInput] = useState(() =>
    String(Number(group.loans[0]?.interestRateBps ?? 0) / 100),
  );
  const [listingDays, setListingDays] = useState<number>(7);
  const consent = useReviewConsent([reviewFingerprint(stage), address, walletChain?.chainId]);

  const rateBps = isPositiveDecimal(rateInput) ? percentToBps(rateInput) : null;
  const rateValid = rateBps !== null && rateBps > 0 && rateBps <= MAX_INTEREST_BPS;
  const disabledBySwitch = flowDisabled('post-offer');

  const ctx: SaleListingCtx | null =
    address && walletChain && publicClient
      ? { publicClient, diamond: walletChain.diamondAddress, holder: address }
      : null;
  const ready = Boolean(ctx && walletClient && onSupportedChain && meta.data);
  const amount = (raw: bigint) =>
    meta.data ? `${formatTokenAmountExact(raw, meta.data.decimals)} ${meta.data.symbol}` : '';
  const byId = new Map(group.loans.map((l) => [l.loanId, l]));

  /** The Terms gate, said before any read: a listing is not an exit, so
   *  the write would be refused at submission (#1961). */
  function termsBlocked(): string | null {
    const verdict = termsVerdict();
    if (verdict === 'ok') return null;
    return verdict === 'unknown' ? copy.errors.termsCheckUnavailable : copy.errors.termsNotAccepted;
  }

  async function plan() {
    if (!ctx || rateBps === null || !rateValid) return;
    const blocked = disabledBySwitch ? copy.killSwitch.disabled : termsBlocked();
    if (blocked) {
      setError(blocked);
      return;
    }
    const terms: SaleListingTerms = {
      rateBps,
      listingSeconds: BigInt(listingDays) * 86400n,
    };
    onHeldChange?.(group, true);
    setError(null);
    // A new review starts unconsented: the tick covers only the figures
    // this review is about to show.
    consent.clear();
    setStage({ kind: 'planning' });
    const plans = await Promise.all(group.loans.map((l) => planSaleListingForBatch(ctx, l, terms)));
    setStage({ kind: 'review', terms, plans });
  }

  const toIdle = () => {
    setError(null);
    consent.clear();
    setStage({ kind: 'idle' });
    onHeldChange?.(group, false);
  };

  async function confirm(terms: SaleListingTerms, plans: SaleListingPlan[]) {
    if (!ctx || !walletClient || !walletChain || !consent.given) return;
    const blocked = flowDisabled('post-offer') ? copy.killSwitch.disabled : termsBlocked();
    if (blocked) {
      setError(blocked);
      return;
    }
    setError(null);
    const leftOut: SaleBatchOutcome[] = plans
      .filter((p) => p.kind === 'refused')
      .map((p) => ({ loanId: p.loanId, kind: 'left-out', reason: p.reason }));
    const reviewed = new Map(
      plans.filter((p): p is ReadyPlan => p.kind === 'ready').map((p) => [p.loanId, p]),
    );
    const outcomes: SaleBatchOutcome[] = [];
    try {
      const chunks = chunkForMulticall([...reviewed.keys()]);
      let sendPending = false;
      for (const [index, chunk] of chunks.entries()) {
        // A transaction still unconfirmed may yet list its loans, so
        // nothing more is sent behind it.
        if (sendPending) {
          for (const id of chunks.slice(index).flat()) {
            leftOut.push({ loanId: id, kind: 'left-out', reason: copy.batchSale.notSentPending });
          }
          break;
        }
        // LATE re-check, immediately before EACH send, in full and bound
        // to the reviewed figures: an earlier transaction, or time, can
        // have moved a loan (a partial repayment lowers the minimum, an
        // offset or another listing can land, the position NFT can move).
        setStage({ kind: 'sending', step: 'checking' });
        const late = await Promise.all(
          chunk.map((id) => planSaleListingForBatch(ctx, byId.get(id)!, terms, reviewed.get(id))),
        );
        for (const p of late) {
          if (p.kind === 'refused') {
            leftOut.push({
              loanId: p.loanId,
              kind: 'left-out',
              reason: p.boundsMoved ? `${p.reason} ${copy.batchSale.reviewAgain}` : p.reason,
            });
          }
        }
        const go = late.filter((p): p is ReadyPlan => p.kind === 'ready');
        if (go.length === 0) continue;
        setStage({ kind: 'sending', step: 'submitting' });
        let submitted: `0x${string}` | null = null;
        let mined: Mined;
        try {
          const { receipt } = await write(
            'multicall',
            [
              encodeBestEffort(
                go.map((p) => ({
                  functionName: 'createLoanSaleOfferBound',
                  args: boundListingArgs(p.loanId, terms, p.bounds),
                })),
              ),
            ],
            { onSubmitted: (hash) => (submitted = hash) },
          );
          mined = { block: receipt.blockNumber, logs: receipt.logs };
        } catch (err) {
          mined = await settleFailedSend(ctx.publicClient, submitted, err);
        }
        sendPending = 'pending' in mined;
        const read = await readBackListings(ctx, go, terms, mined);
        for (const o of read) {
          // The loan page finds its listing's id for cancel from this.
          if (o.kind === 'listed') rememberLoanSaleOffer(walletChain.chainId, o.loanId, o.offerId);
        }
        outcomes.push(...read);
      }
      setStage({ kind: 'done', outcomes: [...outcomes, ...leftOut] });
    } catch (err) {
      // Only the late re-check runs outside a per-loan catch; nothing
      // unsent was listed. What was sent is reported with the rest.
      setError(captureTxError(err));
      setStage({ kind: 'done', outcomes: [...outcomes, ...leftOut] });
    } finally {
      for (const key of ['loanSalePending', 'myOffers', 'myLoans', 'saleExitVerdict', 'loanLive']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
  }

  const busy = stage.kind === 'planning' || stage.kind === 'sending';
  const ids = group.loans.map((l) => `#${l.loanId}`).join(', ');

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">
        <Store aria-hidden />
        <h2 style={{ margin: 0 }}>{copy.batchSale.title(group.offerId)}</h2>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {copy.batchSale.lede(ids)}
      </p>

      {disabledBySwitch ? (
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">{copy.killSwitch.disabled}</span>
        </div>
      ) : null}

      {stage.kind === 'idle' ? (
        <>
          <div className="cluster">
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">{copy.loanSale.rateLabel}</span>
              <input
                className="input"
                inputMode="decimal"
                value={rateInput}
                onChange={(e) => setRateInput(e.target.value.trim())}
                aria-label={copy.loanSale.rateLabel}
              />
            </label>
            <label className="field">
              <span className="field-label">{copy.loanSale.windowLabel}</span>
              <select
                className="input"
                value={listingDays}
                onChange={(e) => setListingDays(Number(e.target.value))}
                aria-label={copy.loanSale.windowLabel}
              >
                {WINDOW_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {copy.loanSale.windowOption(d)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="field-hint" style={{ marginTop: 8 }}>
            {copy.batchSale.windowNote}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 12 }}
            disabled={!ready || !rateValid || disabledBySwitch}
            onClick={() => void plan()}
          >
            {copy.batchSale.listAll}
          </button>
        </>
      ) : null}

      {busy ? (
        <p className="muted">
          <LoaderCircle className="spin" aria-hidden size={16} />{' '}
          {stage.kind === 'planning' ? copy.batchSale.checking : copy.batchSale.phase[stage.step]}
        </p>
      ) : null}

      {stage.kind === 'review' ? (
        <SaleReview
          plans={stage.plans}
          amount={amount}
          consentGiven={consent.given}
          onConsent={consent.set}
          consentNote={<ConsentWithdrawnNote consent={consent} />}
          confirmDisabled={!ready || !consent.given || disabledBySwitch}
          onConfirm={() => void confirm(stage.terms, stage.plans)}
          onCancel={toIdle}
        />
      ) : null}

      {stage.kind === 'done' ? (
        <>
          <ul className="row-list" style={{ listStyle: 'none', padding: 0 }}>
            {stage.outcomes.map((o) => (
              <li key={o.loanId}>{outcomeText(o)}</li>
            ))}
          </ul>
          <button type="button" className="btn" onClick={toIdle}>
            {copy.batchSale.dismiss}
          </button>
        </>
      ) : null}

      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}

function SaleReview({
  plans,
  amount,
  consentGiven,
  onConsent,
  consentNote,
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  plans: SaleListingPlan[];
  amount: (raw: bigint) => string;
  consentGiven: boolean;
  onConsent: (checked: boolean) => void;
  consentNote: ReactNode;
  confirmDisabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const readyCount = plans.filter((p) => p.kind === 'ready').length;
  return (
    <>
      <h3 style={{ marginBottom: 8 }}>{copy.batchSale.review}</h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
        {plans.map((p) => (
          <li key={p.loanId} style={{ marginBottom: 6 }}>
            {p.kind === 'ready' ? (
              <>
                {copy.batchSale.loanFloor(String(p.loanId), amount(p.bounds.minSellerNet))}
                <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {p.bounds.maxHeld > 0n ? (
                    <li>{copy.batchSale.loanHeld(amount(p.bounds.maxHeld))}</li>
                  ) : null}
                  <li>{copy.batchSale.loanSettlementNow(amount(p.settlementNow))}</li>
                  {/* What the loan page says about this loan before it is listed. */}
                  {p.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </>
            ) : (
              copy.batchSale.leftOut(String(p.loanId), p.reason)
            )}
          </li>
        ))}
      </ul>
      {readyCount === 0 ? (
        <>
          <p className="muted">{copy.batchSale.noneReady}</p>
          <button type="button" className="btn" onClick={onCancel}>
            {copy.batchSale.cancel}
          </button>
        </>
      ) : (
        <>
          <label className="cluster" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={consentGiven}
              onChange={(e) => onConsent(e.target.checked)}
              style={{ marginTop: 4 }}
            />
            <span>{copy.batchSale.consentLabel}</span>
          </label>
          {consentNote}
          {/* The same six-row review every other write shows, worded for
              several listings. */}
          <ConfirmReceipt
            busy={false}
            confirmLabel={copy.batchSale.confirm}
            onBack={onCancel}
            onConfirm={onConfirm}
            disabled={confirmDisabled}
            data={{
              youReceive: copy.batchSale.receiveEach,
              youLock: copy.batchSale.lockEach,
              youMayOwe: copy.batchSale.youMayOwe,
              youCanLose: copy.loanSale.receiptCanLose,
              fees: copy.loanSale.receiptFees,
              whenThisEnds: copy.batchSale.endsEach,
            }}
          >
            <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
              <span className="banner-body">{copy.batchSale.lockWarning}</span>
            </div>
          </ConfirmReceipt>
        </>
      )}
    </>
  );
}

function outcomeText(o: SaleBatchOutcome): string {
  const id = String(o.loanId);
  switch (o.kind) {
    case 'listed':
      return copy.batchSale.listed(id, o.offerId);
    case 'changed':
      return copy.batchSale.changedOtherwise(id);
    case 'open':
      return copy.batchSale.notListed(id, o.reason);
    case 'left-out':
      return copy.batchSale.leftOut(id, o.reason);
    case 'unknown':
      return copy.batchSale.unknown(id);
    case 'pending':
      return copy.batchSale.pending(id);
  }
}
