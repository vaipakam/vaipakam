/**
 * Borrower refinance — the T-092-H tagged-atomic path, advanced mode.
 * FORM ONLY: the pending request's standing surface (banner, funding
 * watch, cancel) is the page-owned RefinancePendingCard, driven by
 * useRefinancePending — a live request must outlive this card's
 * mount gates.
 *
 * The borrower posts a refinance-tagged Borrower offer for EXACTLY
 * the old loan's principal, with the old collateral's identity
 * repeated so it CARRIES OVER (nothing is pulled at create; the lien
 * re-tags old→new inside the lender's accept). The moment any lender
 * accepts, one transaction: new loan opens → old lender is paid
 * principal + full-term remaining interest from the borrower's
 * wallet (via the standing approval set here) → old loan closes →
 * collateral moves.
 *
 * CARRY-OVER BINDS TO THE ORIGINAL BORROWER: the contract's
 * carry-over predicate compares the offer creator to the borrower
 * stored at loan init, NOT the current position-NFT holder. For a
 * transferred position the same offer would silently become a FRESH
 * collateral pledge pulled from the poster's wallet — so this
 * surface is only offered when the connected wallet IS the original
 * borrower (parent gate on the indexed row + a live re-check at
 * submit).
 *
 * Three wallet steps behind ONE reviewed confirm:
 *   1. setAutoRefinanceCaps — on-chain guardrails at the reviewed
 *      rate ceiling and end-date window (skipped when already
 *      sufficient; the request's OWN expiry is what bounds its
 *      lifetime, so looser pre-existing caps are harmless).
 *   2. Standing approval on the old principal asset for the payoff
 *      (exact; the pull only shrinks as partials settle interest).
 *   3. createOffer with the refinance tag and a hard `expiresAt` at
 *      the disclosed request lifetime.
 * If the user abandons the sequence after step 2, the approval is
 * best-effort revoked — a payoff-sized authorization must not linger
 * behind a pristine form with nothing to cancel.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseEventLogs } from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, submitErrorText } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance, revokeAllowance } from '../contracts/erc20';
import {
  assertAssetNotPausedLive,
  assertErc20BalanceLive,
  assertPositionNftHeldLive,
} from '../contracts/preflights';
import {
  LOAN_STATUS_ACTIVE,
  readLoanLive,
  refinancePayoffOf,
  type LoanLive,
} from '../contracts/loanLive';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import { readLiveProtocolFees, useProtocolFees } from '../data/fees';
import type { IndexedLoan } from '../data/indexer';
import {
  MAX_INTEREST_BPS,
  percentToBps,
  toRefinanceOfferPayload,
} from '../lib/offerSchema';
import {
  formatBpsAsPercent,
  formatTokenAmount,
} from '../lib/format';
import { ConfirmReceipt } from './ConfirmReceipt';
import type { TokenMeta } from '../contracts/erc20';

/** The request's on-chain lifetime (its `expiresAt`), and the extra
 *  headroom the caps' end-date window carries past the new-loan
 *  duration. Disclosed in the review; enforced by the OFFER's own
 *  expiry (accept refuses an expired offer), so it holds even when
 *  looser caps pre-exist. */
const REQUEST_WINDOW_DAYS = 30n;

export function RefinanceFlow({
  row,
  live,
  chainNow,
  principalMeta,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  onPosted,
  busy,
  setBusy,
}: {
  row: IndexedLoan;
  live: LoanLive;
  /** Chain time from the parent's live query — maturity gates never
   *  trust the device clock. */
  chainNow: bigint;
  principalMeta: TokenMeta;
  /** Page-wide single-confirm-surface slot (see PositionDetails). */
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** Hands the created offer id to the page-owned pending state. */
  onPosted: (offerId: string) => void;
  /** The PAGE's shared write lock — the posting sequence spans up to
   *  three wallet confirmations, and the sibling repay-family
   *  buttons must not stay live underneath it. */
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const fees = useProtocolFees();

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

  // Any term edit voids a previously ticked acknowledgement — the
  // page-wide consent rule (consent covers exactly what was reviewed).
  function setTerm(setter: (v: string) => void, value: string) {
    setter(value);
    setConsent(false);
    onCloseConfirm();
  }

  // ---- Derived figures (display; submit re-reads live) -------------
  const payoff = refinancePayoffOf(live);
  const payoffInterest = payoff - live.principal;
  const lifWei = (live.principal * BigInt(fees.loanInitiationFeeBps)) / 10_000n;
  // What the wallet must hold SPARE at accept: the payoff is pulled,
  // but the new principal minus LIF arrives in the same tx.
  const walletTopUp = payoffInterest + lifWei;

  const rateBps = isPositiveDecimal(rateInput) ? percentToBps(rateInput) : null;
  const durationDays = /^\d+$/.test(durationInput)
    ? parseInt(durationInput, 10)
    : null;
  const durationValid =
    durationDays !== null &&
    durationDays >= 1 &&
    durationDays <= fees.maxOfferDurationDays;
  const rateValid = rateBps !== null && rateBps > 0 && rateBps <= MAX_INTEREST_BPS;

  const sym = principalMeta.symbol;
  const dec = principalMeta.decimals;
  const payoffStr = `${formatTokenAmount(payoff, dec)} ${sym}`;
  const topUpStr = `${formatTokenAmount(walletTopUp, dec)} ${sym}`;

  // The consent rule covers the FIGURES too: the live-loan prop and
  // the fee config refresh in the background, so a payoff/fee quote
  // can change inside an open review — a tick given against the old
  // numbers must not survive.
  useEffect(() => {
    setConsent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payoffStr, topUpStr, fees.loanInitiationFeeBps, fees.treasuryFeeBps]);

  const matured = chainNow >= live.startTime + live.durationDays * 86_400n;

  async function submit() {
    if (!address || !walletChain || !walletClient || !publicClient) return;
    if (rateBps === null || durationDays === null) return;
    setBusy(true);
    setError(null);
    // Tracks whether THIS attempt granted the payoff approval, so an
    // abandoned step 3 can unwind it (see header).
    let approvalGranted = false;
    let approvalToken: `0x${string}` | null = null;
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
      // values would break carry-over), chain time, the existing
      // guardrails, live fees (the receipt quoted the cached config),
      // and both legs' pause state (asset addresses are immutable on
      // a loan, so the indexed row's addresses are safe here).
      const [, liveLoan, latestBlock, caps, liveFees] = await Promise.all([
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
      // Carry-over binds to the ORIGINAL borrower (see header) — the
      // parent gate used the indexed row; re-check against the chain.
      if (liveLoan.borrower.toLowerCase() !== address.toLowerCase()) {
        setError(copy.errors.refinanceNotOriginalBorrower);
        return;
      }
      const endTime = liveLoan.startTime + liveLoan.durationDays * 86_400n;
      if (latestBlock.timestamp >= endTime) {
        setError(copy.errors.refinanceMatured);
        return;
      }
      // The receipt quoted the CACHED fee config — a governance retune
      // inside its window must force a re-review, not a silent drift
      // between the quoted fees and the enforced ones.
      if (
        liveFees.treasuryFeeBps !== fees.treasuryFeeBps ||
        liveFees.loanInitiationFeeBps !== fees.loanInitiationFeeBps ||
        liveFees.maxOfferDurationDays !== fees.maxOfferDurationDays
      ) {
        void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
        throw new Error(copy.match.termsChanged);
      }
      // Guardrails: rate ceiling = the reviewed rate; end-date window
      // = accept-time + duration must fit inside it. Only (re)written
      // when the existing caps don't already cover the reviewed terms
      // — the OFFER's own rate ceiling and expiry are what bind the
      // accept, so looser pre-existing caps are harmless.
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
      const livePayoff = refinancePayoffOf(liveLoan);
      // The approval itself needs no balance, but a wallet that can't
      // even cover the INTEREST portion today should hear it now, not
      // via a failed accept later. (The principal arrives in the
      // accept tx itself, so only the top-up is checked — with the
      // LIVE fee config.)
      await assertErc20BalanceLive({
        publicClient,
        token: liveLoan.principalAsset,
        owner: address,
        amount:
          livePayoff - liveLoan.principal +
          (liveLoan.principal * BigInt(liveFees.loanInitiationFeeBps)) / 10_000n,
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
      approvalGranted = true;
      approvalToken = liveLoan.principalAsset;
      const payload = toRefinanceOfferPayload(liveLoan, row.loanId, {
        rateBpsMax: rateBps,
        durationDays,
        consent,
        // The request's own hard expiry — this is what makes the
        // reviewed lifetime true even when looser caps pre-exist.
        expiresAt: latestBlock.timestamp + REQUEST_WINDOW_DAYS * 86_400n,
      });
      const { receipt } = await write('createOffer', [payload]);
      const created = parseEventLogs({
        abi: DIAMOND_ABI_VIEM,
        logs: receipt.logs,
        eventName: 'OfferCreated',
      }) as unknown as Array<{ args: { offerId: bigint } }>;
      const offerId = created[0]?.args.offerId;
      if (offerId !== undefined) onPosted(offerId.toString());
      setDone(copy.refinance.done);
      setConsent(false);
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
    } catch (err) {
      setError(submitErrorText(err));
      // No offer was created but the payoff approval mined — unwind
      // it so a rejected step 3 leaves no payoff-sized authorization
      // behind a pristine form with nothing to cancel. Best-effort:
      // a second rejection just leaves the wallet's approvals view
      // as the remedy (the error banner already shows the failure).
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

  // ---- Render -------------------------------------------------------
  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);

  // Matured (by live chain time + live term): refinance no longer
  // applies — the plain Repay path settles a matured loan. (A pending
  // request's surface lives in RefinancePendingCard, which the page
  // keeps mounted regardless.)
  if (matured) return null;

  return (
    <section className="card">
      <h3>{copy.refinance.title}</h3>
      <p className="muted">{copy.refinance.blurb}</p>

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
                whenThisEnds: `When a lender accepts your request, when you cancel it, or when it expires ${Number(REQUEST_WINDOW_DAYS)} days after posting. ${copy.refinance.guardrailNote}`,
              }}
            >
              {live.periodicInterestCadence !== 0 ? (
                <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                  <span className="banner-body">{copy.refinance.cadenceChangeNote}</span>
                </div>
              ) : null}
              <p className="muted" style={{ marginBottom: 12 }}>
                {copy.refinance.multiStepNote}
              </p>
            </ConfirmReceipt>
          </div>
        )}
      </div>

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
