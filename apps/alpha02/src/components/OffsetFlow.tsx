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
import { readLiveProtocolFees, useProtocolFees } from '../data/fees';
import { LOCK_PRECLOSE_OFFSET } from '../data/offsetPending';
import { LOCK_EARLY_WITHDRAWAL_SALE } from '../data/loanSalePending';
import type { IndexedLoan } from '../data/indexer';
import { MAX_INTEREST_BPS, percentToBps } from '../lib/offerSchema';
import { exactAmountString, formatTokenAmount } from '../lib/format';
import { ConfirmReceipt } from './ConfirmReceipt';
import type { TokenMeta } from '../contracts/erc20';

/** Headroom reserved between the offset's replacement maturity and the
 *  original loan's maturity when sizing the DEFAULT/max term. The
 *  contract's bound is seconds-precise and judged at execution time
 *  (`block.timestamp + duration·1day > maturity` reverts), so a term
 *  computed to fit EXACTLY only survives if it executes in the same
 *  second — the wallet-confirmation window alone breaks that. Ten
 *  minutes comfortably covers confirmation + RPC/simulation lag while
 *  costing at most one whole day of term near a day boundary. */
const OFFSET_MATURITY_MARGIN_SECONDS = 600n;

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
  // (seconds-precise on-chain; whole days here rounds DOWN) AND within
  // the protocol's live offer-duration ceiling — governance can lower
  // that below the remaining term, and createOffer rejects a longer
  // duration (Codex #1500 r4). The form uses the tighter of the two;
  // submit re-reads the ceiling live.
  //
  // The MARGIN is load-bearing: "rounds down" alone still yields the
  // boundary-EXACT term when the remaining time is a whole number of
  // days — exactly the state right after acceptance, where the
  // contract's `now + duration > maturity` guard passes only in the
  // same second it was computed. Every second between computing the
  // default and the transaction executing (wallet confirmation, RPC
  // lag — or on the e2e fork, anvil stamping the pending block with
  // wall time while the latest block still carries the acceptance
  // timestamp) pushes the boundary term past maturity and reverts
  // InvalidOfferTerms. Reserving headroom makes the default a term
  // that still fits by the time it lands.
  const fees = useProtocolFees();
  const maxDurationDays = (() => {
    const end = loanEndTimeOf(live);
    const usable = end - OFFSET_MATURITY_MARGIN_SECONDS;
    const remaining = usable > chainNow ? (usable - chainNow) / 86_400n : 0n;
    if (!fees.ready) return remaining;
    const cap = BigInt(fees.maxOfferDurationDays);
    return remaining < cap ? remaining : cap;
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
  // Safe-integer guard BEFORE any BigInt conversion: a long-enough
  // pasted digit string overflows parseInt to a non-safe float (or
  // Infinity), and BigInt(Infinity) throws at render — validation
  // must reject it, not crash the page (Codex #1500 r1).
  const durationDays = /^\d+$/.test(durationInput)
    ? parseInt(durationInput, 10)
    : null;
  const durationValid =
    durationDays !== null &&
    Number.isSafeInteger(durationDays) &&
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
    if (
      rateBps === null ||
      durationDays === null ||
      collateralWei === null ||
      !rateValid ||
      !durationValid ||
      !collateralValid
    ) {
      return;
    }
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
      const [, liveLoan, latestBlock, borrowerLock, lenderLock, liveFees] =
        await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.borrowerTokenId,
          expectedOwner: address,
        }),
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        publicClient.getBlock({ blockTag: 'latest' }),
        // Codex #1500 r4 — a cross-device offset posted since this
        // form's cached read already holds the PrecloseOffset lock;
        // `offsetWithNewOffer` would revert OffsetAlreadyActive AFTER
        // this path raised the allowance. Read the live lock in the
        // same batch and stop before any approval (fail closed: this
        // read throws on transport failure).
        publicClient
          .readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'positionLock',
            args: [BigInt(row.borrowerTokenId)],
          })
          .then((v) => Number(v)),
        // The LENDER position's lock too: a live sale listing on the
        // other side of this loan also blocks an offset on chain, and
        // it is invisible from the borrower token (Codex #1500 r5).
        publicClient
          .readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'positionLock',
            args: [BigInt(row.lenderTokenId)],
          })
          .then((v) => Number(v)),
        // The live offer-duration ceiling: governance can lower
        // maxOfferDurationDays below this loan's remaining term, and
        // createOffer rejects a longer duration — catch it before the
        // approval, like the other offer-creation flows (Codex r4).
        readLiveProtocolFees(publicClient, walletChain.diamondAddress),
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
      // ANY nonzero borrower-position lock conflicts, not just an
      // offset: a live NFT prepay-collateral listing locks the same
      // token under a different reason and `offsetWithNewOffer` would
      // revert after the approval mined. And a concurrent lender sale
      // locks the OTHER token — invisible on the borrower side — which
      // the contract refuses too (Codex #1500 r5). Fail before the
      // approval in every case; only the offset case gets its own copy.
      if (borrowerLock === LOCK_PRECLOSE_OFFSET) {
        setError(copy.offset.alreadyLive);
        void queryClient.invalidateQueries({ queryKey: ['offsetPending'] });
        return;
      }
      if (borrowerLock !== 0 || lenderLock === LOCK_EARLY_WITHDRAWAL_SALE) {
        setError(copy.offset.blockedByOtherLock);
        void queryClient.invalidateQueries({ queryKey: ['offsetPending'] });
        void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
        return;
      }
      if (durationDays > liveFees.maxOfferDurationDays) {
        setError(copy.offset.durationOverCap(liveFees.maxOfferDurationDays));
        void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
        return;
      }
      // Re-judge the term bound by LIVE chain time — the reviewed
      // duration can stop fitting while the receipt sits open. The
      // same margin the default reserves applies here: judging at the
      // exact boundary passes a term the contract will reject seconds
      // later (the latest block's stamp always trails execution time —
      // pathologically so on the e2e fork, where no block mines
      // between acceptance and this check).
      if (
        latestBlock.timestamp +
          BigInt(durationDays) * 86_400n +
          OFFSET_MATURITY_MARGIN_SECONDS >
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
      // The receipt disclosed the completion bound from the parent's
      // live snapshot — if the loan's economics moved since (a keeper
      // extendLoanInPlace re-stamps rate/term while the receipt sits
      // open), the standing allowance about to be granted exceeds the
      // figure the user consented to. Force a fresh review instead of
      // signing undisclosed headroom (Codex #1500 r2 P1); a SHRUNK
      // bound (a partial settled) is fine — the pull only gets smaller.
      if (liveBound > completionBound) {
        setError(copy.match.termsChanged);
        void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
        return;
      }
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
      // Codex #1539 r1 — `ensureAllowance` can add its OWN approval
      // transaction and wallet-confirm window between the early
      // maturity re-judge above and this write. Re-judge against a
      // FRESH block here so that window can't silently consume the
      // reserve and hand the user the very revert the margin exists
      // to prevent. The early check stays — it fails fast before any
      // approval is spent.
      const blockAtWrite = await publicClient.getBlock();
      if (
        blockAtWrite.timestamp +
          BigInt(durationDays) * 86_400n +
          OFFSET_MATURITY_MARGIN_SECONDS >
        loanEndTimeOf(liveLoan)
      ) {
        setError(copy.offset.onlyBeforeDue);
        return;
      }
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
            disabled={busy}
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
            disabled={busy}
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
            disabled={busy}
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
              disabled={busy}
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
