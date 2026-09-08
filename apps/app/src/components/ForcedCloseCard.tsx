/**
 * "This loan is overdue" — the lender's forced close-out.
 *
 * `DefaultedFacet.triggerDefault` has been on-chain the whole time and
 * has never had a surface in this app, so a lender whose borrower
 * simply stopped paying could watch the grace period expire and had no
 * way to act on it from the product. This card is that way.
 *
 * ## Why it renders in states it cannot act on
 *
 * Every non-terminal readiness renders, including `unknown` and
 * `not-yet`. That is the opposite of the usual "hide what you can't
 * do" instinct, and it is deliberate: a lender cannot ask for a route
 * they have never been shown, and this capability stayed invisible for
 * exactly as long as nothing drew it. A card that explains what it is
 * waiting on is worth more here than a clean empty space.
 *
 * ## The one state that shows no button on purpose
 *
 * `ready-needs-route` is genuinely closable on-chain — a keeper could
 * do it this second — but the app cannot build the `AdapterCall[]` the
 * contract requires for liquid collateral, and `swapWithFailover`
 * reverts `NoEnabledSwapRoute` on an empty try-list rather than falling
 * back. So there is no submit button: offering one would sell the
 * lender a guaranteed revert at their own expense. The card says the
 * position is eligible and that the app is the limitation, because
 * blaming the protocol for an app gap would send them to the wrong
 * place for help.
 *
 * ## What this card never says
 *
 * No amount, ever — `triggerDefault` picks between an internal match, a
 * DEX sale and a full-collateral fallback while the transaction runs.
 * No exclusivity — the call is permissionless. And never that money
 * arrives on its own; closing sets the loan terminal and the lender
 * claims afterwards. Each of those would be a sentence the contract
 * does not support, on the one card whose whole job is telling somebody
 * how they get paid.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { AlertTriangle } from 'lucide-react';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useDiamondWrite, DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { ConfirmReceipt } from './ConfirmReceipt';
import {
  canSubmitFromApp,
  shouldRenderForcedClose,
  type ForcedCloseReadiness,
} from '../data/forcedClose';

export function ForcedCloseCard({
  loanId,
  readiness,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  busy,
  setBusy,
  onClosedOut,
}: {
  loanId: string | number;
  /** Resolved by `decideForcedClose` from live reads — never derived
   *  in this component. The card renders the decision; it does not
   *  make it. */
  readiness: ForcedCloseReadiness;
  /** The page's single confirmation slot — opening this receipt closes
   *  any other, matching every other write card on the page. */
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** The page-wide write mutex, so two wallet prompts cannot race. */
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** Lets the page refetch status after the loan goes terminal. */
  onClosedOut: () => void;
}) {
  const { write, ready } = useDiamondWrite();
  const { walletChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  /** Latched the moment a close-out confirms, and never unlatched.
   *
   *  Round 28 P2 — the refetch after a successful close is
   *  fire-and-forget, so TanStack keeps serving `defaultable: true` and
   *  the old route verdict while it revalidates, and `useLoan` can hold
   *  a still-Active indexed row for longer still. Without this the
   *  button reappeared under the lender within the same second and
   *  invited a second wallet prompt for a loan that is now terminal —
   *  a guaranteed `InvalidLoanStatus`. The page's own status
   *  reconciliation removes the card properly a moment later; this only
   *  has to cover the gap. */
  const [closedThisSession, setClosedThisSession] = useState(false);

  if (!shouldRenderForcedClose(readiness)) return null;

  const submittable = canSubmitFromApp(readiness) && !closedThisSession;

  async function closeOut() {
    setError(null);
    setBusy(true);
    try {
      // The empty try-list is correct HERE and only here. `submittable`
      // is true only for `ready-in-kind`, which is precisely the set of
      // loans — NFT rentals, illiquid collateral, and >110% LTV
      // collapses — that `triggerDefault` routes to in-kind
      // disposition without consulting a swap adapter. For anything
      // else this array would revert `NoEnabledSwapRoute`, which is why
      // the button does not exist in that state.
      // A LIVE re-check, immediately before sending (round 28 P2). The
      // readiness above is a 30-second poll that the open confirmation
      // can outlive by minutes, and several of the facts behind it move
      // on their own: collateral can be re-priced from illiquid to
      // liquid, a collapsed LTV can recover below the threshold,
      // governance can pause. Each of those turns this exact empty
      // try-list from correct into a guaranteed revert — the paid
      // refusal the whole card exists to prevent. Simulating asks the
      // chain the only question that matters ("would this call succeed
      // right now?") instead of re-deriving the answer from a second
      // copy of the contract's branch rules.
      //
      // It also, without special-casing any of them, covers the gates
      // this decision does not model: `whenNotPaused`, the lender KYC
      // check on an enforcement-enabled deployment, and a consent flag
      // read a moment too early.
      if (publicClient && address) {
        await publicClient.simulateContract({
          address: walletChain!.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'triggerDefault',
          args: [BigInt(loanId), []],
          account: address,
        });
      }
      await write('triggerDefault', [BigInt(loanId), []]);
      setClosedThisSession(true);
      onClosedOut();
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['forcedClose'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  const body = closedThisSession
    ? copy.forcedClose.submitted
    : readiness === 'not-yet'
      ? copy.forcedClose.notYet
      : readiness === 'unknown'
        ? copy.forcedClose.unknown
        : readiness === 'blocked-sequencer'
          ? copy.forcedClose.blockedSequencer
          : readiness === 'blocked-paused'
            ? copy.forcedClose.blockedPaused
            : readiness === 'blocked-no-consent'
              ? copy.forcedClose.blockedNoConsent
              : readiness === 'ready-needs-route'
                ? copy.forcedClose.readyNeedsRoute
                : copy.forcedClose.readyInKind;

  /** The overdue heading ONLY where the chain has actually said so.
   *
   *  Round 28 P2 — `blocked-sequencer` and `blocked-paused` are
   *  resolved BEFORE `defaultable` is consulted, deliberately, so
   *  during an outage a loan three days into a ninety-day term reaches
   *  them. Mapping those to "This loan is overdue" put a false
   *  statement in the card's largest text on every position, for the
   *  duration of every outage. Only the states downstream of an
   *  affirmative `defaultable` may claim it. */
  const overdueEstablished =
    readiness === 'ready-in-kind' ||
    readiness === 'ready-needs-route' ||
    readiness === 'blocked-no-consent';

  return (
    <section className="card" data-testid="forced-close-card">
      <div className="card-title">
        <AlertTriangle aria-hidden />
        <h3 style={{ margin: 0 }}>
          {overdueEstablished
            ? copy.forcedClose.title
            : copy.forcedClose.titlePending}
        </h3>
      </div>

      <p className="muted" data-testid="forced-close-body">
        {body}
      </p>

      {/* Shown on both ready states — a lender who cannot submit here
          still needs to know a keeper may close it, so that finding the
          position already closed reads as normal rather than as loss. */}
      {!closedThisSession &&
      (readiness === 'ready-in-kind' || readiness === 'ready-needs-route') ? (
        <>
          <p className="field-hint">{copy.forcedClose.notExclusive}</p>
          <p className="field-hint">{copy.forcedClose.outcomeNote}</p>
          <p className="field-hint">{copy.forcedClose.claimNote}</p>
        </>
      ) : null}

      {submittable ? (
        <>
          <p className="field-hint">{copy.forcedClose.intentNote}</p>
          {error ? (
            <div
              className="banner banner-danger"
              role="alert"
              style={{ marginBottom: 12 }}
            >
              {error}
            </div>
          ) : null}
          {!confirmOpen ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onOpenConfirm}
              disabled={busy || !ready}
              data-testid="forced-close-submit"
            >
              {copy.forcedClose.submit}
            </button>
          ) : (
            <div style={{ marginTop: 8 }}>
              <ConfirmReceipt
                busy={busy}
                confirmLabel={copy.forcedClose.submit}
                onBack={onCloseConfirm}
                onConfirm={closeOut}
                data={{
                  youReceive: copy.forcedClose.receipt.youReceive,
                  youLock: copy.forcedClose.receipt.youLock,
                  youMayOwe: copy.forcedClose.receipt.youMayOwe,
                  youCanLose: copy.forcedClose.receipt.youCanLose,
                  fees: copy.forcedClose.receipt.fees,
                  whenThisEnds: copy.forcedClose.receipt.whenThisEnds,
                }}
              />
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
