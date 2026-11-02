/**
 * Claim-All card (#1268 / E-10) — collect every ready payout in ONE
 * wallet signature via `MulticallFacet.multicall`, instead of one
 * transaction per claim.
 *
 * The card is additive: the per-loan claim (on the position detail
 * page) and the standalone rewards button still exist as the granular
 * path. This is the convenience batch over the same claims.
 *
 * Honesty:
 *   - Each item is `allowFailure: true`, so an item another party
 *     finalized between preview and tx is SKIPPED, not fatal — the rest
 *     still execute. Per-item success is surfaced by RE-DERIVING
 *     eligibility after the receipt: claimed items drop off the lists
 *     below; anything skipped remains, claimable on its own.
 *   - `withdrawVPFIFromVault` pulls parked VPFI that backs the fee
 *     discount, so it is opt-IN (off by default) with a warning.
 *   - The batch may include `claimInteractionRewards`; a live,
 *     fail-closed sanctions re-read gates submission (matching the
 *     standalone rewards button).
 *   - The card renders only once the rewards + vault-VPFI reads have
 *     SETTLED, so a still-loading read never silently drops a leg; if
 *     either read failed, the card says so instead of pretending the
 *     batch is complete.
 */
import { useState } from 'react';
import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import type { ClaimableLoan } from '../data/claimables';
import { useInteractionRewards } from '../data/rewards';
import { useClaimPayoutText } from '../data/useClaimPayout';
import { useVpfi } from '../data/vpfi';
import { assertRewardRecipientNotBarredLive, useRewardBarCheck } from '../data/sanctions';
import {
  buildClaimAllItems,
  defaultSelectedKeys,
  encodeClaimAllCalls,
  MAX_CLAIM_ALL,
} from '../data/claimAll';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { captureTxError } from '../lib/errors';
import {
  ownPayoutRoute,
  ownWithdrawalVerdict,
  gateAccount,
  payoutOutcomes,
  payoutRoute as routeOf,
  useProtectedAccount,
  useProtectedAccounts,
  type RouteAccount,
} from '../data/protectedAccount';
import { payoutOutcomesText, payoutRouteText } from '../lib/payoutRouteText';
import { AssetType } from '../lib/types';
import {
  useVisibleWindow,
  ShowMoreButton,
  LIST_WINDOW_PAGE,
} from '../lib/visibleWindow';

export function ClaimAllCard({ loans }: { loans: ClaimableLoan[] }) {
  const { address, walletChain, onSupportedChain, readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();
  const { write } = useDiamondWrite();

  const rewards = useInteractionRewards();
  const vpfi = useVpfi();
  // Cached screen for the disabled state — the contract's own BAR (flagged,
  // or marked while the oracle is unreachable; Codex #2489 r8), since the
  // batch's reward leg refuses exactly that; the live re-read below answers
  // the same way at submit time.
  const sanctions = useRewardBarCheck();
  const sanctionsClear = sanctions.ready && !sanctions.barred;

  // Protected account mode: where what this batch pays lands, and whether
  // its vault-VPFI leg (a withdrawal) can be sent at all; the contract
  // refuses that leg for a locked account or a full queue, which would
  // revert the whole batch.
  const protection = useProtectedAccount(address ?? undefined);
  const payoutRoute = ownPayoutRoute(protection.data, protection.isError);
  // A loan claim pays out of the RECORDED party's vault, so each distinct
  // other source is read too: its gate catches a payment to its controller.
  const claimSource = (loan: ClaimableLoan) => (loan.role === 'lender' ? loan.lender : loan.borrower);
  const otherSources = [
    ...new Set(
      loans
        .map((l) => claimSource(l).toLowerCase())
        .filter((a) => !address || a !== address.toLowerCase()),
    ),
  ] as `0x${string}`[];
  const sourceReads = useProtectedAccounts(otherSources);
  const me: RouteAccount = { address: address ?? undefined, snap: protection.data, readFailed: protection.isError };
  const sourceAccount = (source: string | undefined): RouteAccount | undefined => {
    const i = source ? otherSources.indexOf(source.toLowerCase() as `0x${string}`) : -1;
    return i < 0 ? undefined : { address: source, snap: sourceReads[i]?.data, readFailed: Boolean(sourceReads[i]?.isError) };
  };
  const vpfiWithdrawal = ownWithdrawalVerdict(protection.data, protection.isError);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomeNote, setOutcomeNote] = useState<string | null>(null);
  // User's EXPLICIT checkbox choices, keyed by item key. Anything not
  // here follows the item's default — so a manual uncheck survives a
  // background balance/candidate refresh (the reset-to-defaults shape
  // would silently re-check it), while a claimed item simply leaves the
  // map behind harmlessly.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  // Per-wallet/chain opt-ins must NOT leak: `rewards` / `vpfi-vault`
  // keys are wallet-agnostic, so a prior opt-in to the vault withdrawal
  // would start CHECKED for the next cached account without an unmount.
  // Reset the override map when the acting identity changes (Codex #1291
  // r1) — render-phase, the useVisibleWindow pattern.
  const identity = `${readChain.chainId}|${address?.toLowerCase() ?? ''}`;
  const [prevIdentity, setPrevIdentity] = useState(identity);
  if (prevIdentity !== identity) {
    setPrevIdentity(identity);
    setOverrides({});
    setOutcomeNote(null);
  }

  // Wait for rewards + vault VPFI to SETTLE before offering the batch:
  // a still-loading read defaults its amount to 0n, which would silently
  // drop that leg from a batch the user thinks is complete.
  // The last batch's outcome stays on screen even once its claims leave the
  // list and no further batch is on offer: it may be the only place a
  // payment kept in the vault is explained.
  const outcomeOnly = outcomeNote ? (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="banner banner-info" role="status">
        <span className="banner-body">{outcomeNote}</span>
      </div>
    </section>
  ) : null;
  if (rewards.isPending || vpfi.isPending) return outcomeOnly;

  const items = buildClaimAllItems({
    loans,
    rewardsPending: rewards.data?.pending ?? 0n,
    vpfiFree: vpfi.data?.freeBalance ?? 0n,
    labels: copy.claimAll,
  });

  // The batch only makes sense for two or more payouts — a single claim
  // already has its own button/row. (Claims.tsx suppresses the "no
  // claims yet" empty state when there ARE non-loan payouts, so a pure
  // rewards+vault batch no longer contradicts it — Codex #1291 r1.)
  if (items.length < 2) return outcomeOnly;

  // Pre-check defaults only up to the FIRST window page: seeding up to
  // MAX_CLAIM_ALL (30) while the checklist initially renders one page
  // (25) would pre-select items hidden below the fold, breaking the
  // per-item preview promise (Codex #1291 r1). Never exceed the batch
  // bound either.
  const defaultOn = defaultSelectedKeys(
    items,
    Math.min(LIST_WINDOW_PAGE, MAX_CLAIM_ALL),
  );
  const isSelected = (key: string) => overrides[key] ?? defaultOn.has(key);
  const selectedKeys = items.filter((i) => isSelected(i.key)).map((i) => i.key);
  const selectedCount = selectedKeys.length;

  const hasVpfiVault = items.some((i) => i.kind === 'vpfi-vault');
  // Where the batch pays, per leg. A loan claim pays out of the RECORDED
  // party's vault (another account's for a transferred position, which the
  // vault layer credits to a protected claimant's vault instead of queueing);
  // the vault-VPFI withdrawal follows the account's own route; a protected
  // account's interaction rewards are always credited to its vault (the
  // reward claim's own rule), so they never queue. One note per distinct
  // route among the selected legs.
  const selectedItems = items.filter((i) => isSelected(i.key));
  const selectedKinds = new Set(selectedItems.map((i) => i.kind));
  const legRouteNotes = new Set<string>();
  // Legs run in order inside one transaction, so each queued leg takes a row
  // the next one cannot: count them per queue (one row per leg, the least a
  // leg can take), so a leg past the cap reads as kept in the vault.
  const rowsTaken = new Map<string, number>();
  for (const i of selectedItems) {
    if (i.kind === 'rewards') continue;
    const source = sourceAccount(i.loan ? claimSource(i.loan) : undefined);
    const route = routeOf(me, source, (a) => rowsTaken.get(a?.toLowerCase() ?? '') ?? 0);
    const gate = gateAccount(me, source);
    if (route.kind === 'queued' && gate && gate !== 'unread' && gate.address) {
      const key = gate.address.toLowerCase();
      rowsTaken.set(key, (rowsTaken.get(key) ?? 0) + 1);
    }
    const note = payoutRouteText(route);
    if (note) legRouteNotes.add(note);
  }
  if (payoutRoute.kind === 'unread' && selectedItems.length > 0) {
    const note = payoutRouteText(payoutRoute);
    if (note) legRouteNotes.add(note);
  }
  const rewardsToVaultNote =
    selectedKinds.has('rewards') && (payoutRoute.kind === 'queued' || payoutRoute.kind === 'vault')
      ? copy.protection.payoutRouteRewardsToVault
      : null;
  const tooMany = selectedCount > MAX_CLAIM_ALL;
  const vpfiLegBlocked = selectedKeys.some((k) => items.find((i) => i.key === k)?.kind === 'vpfi-vault') &&
    vpfiWithdrawal.kind !== 'open';
  const canSubmit =
    !busy &&
    onSupportedChain &&
    sanctionsClear &&
    selectedCount > 0 &&
    !tooMany &&
    !vpfiLegBlocked;

  function toggle(key: string) {
    const now = isSelected(key);
    setOverrides((prev) => ({ ...prev, [key]: !now }));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setOutcomeNote(null);
    try {
      if (!address || !walletChain || !publicClient) {
        throw new Error(copy.wallet.connectFirst);
      }
      // The batch can include claimInteractionRewards (and fund-out
      // claim/withdraw paths). Re-read the BAR live, FAIL-OPEN (Codex #2489
      // r4, r8): every leg screens on chain — the reward claim with the
      // marker-aware rule since #1566 — so an unreadable oracle does not block
      // an unmarked wallet here while the contract would pay it, and a marked
      // wallet is refused here as it would be there. The re-read only spares a
      // doomed signature.
      await assertRewardRecipientNotBarredLive(publicClient, walletChain.diamondAddress, address);
      const chosen = items.filter((i) => isSelected(i.key));
      if (chosen.length === 0) return;
      const calls = encodeClaimAllCalls(chosen);
      const { receipt } = await write('multicall', [calls]);
      // Where each payment landed, read from the receipt, never assumed: a
      // leg may have been queued, or kept in the vault once a queue filled.
      // Every leg's outcomes, gathered across the whole receipt and each
      // stated once: a batch can both queue and hold.
      const outcomes = chosen
        .filter((leg) => leg.kind !== 'rewards')
        .flatMap((leg) => payoutOutcomes(receipt.logs, address, leg.loan ? claimSource(leg.loan) : undefined));
      const outcomeText = payoutOutcomesText(outcomes, address);
      setOutcomeNote(outcomeText);
      // Post-receipt re-derivation surfaces per-item outcome: claimed
      // items disappear from these lists; skipped items remain.
      void queryClient.invalidateQueries({ queryKey: ['claimables'] });
      void queryClient.invalidateQueries({ queryKey: ['interactionRewards'] });
      void queryClient.invalidateQueries({ queryKey: ['vpfi'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">
        <CheckCircle2 aria-hidden />
        <h2 style={{ margin: 0 }}>{copy.claims.allTitle}</h2>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {copy.claims.allBlurb}
      </p>

      <ClaimAllChecklist
        items={items}
        isSelected={isSelected}
        onToggle={toggle}
        disabled={busy}
      />

      {hasVpfiVault ? (
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {copy.claims.allVpfiNote}
        </p>
      ) : null}
      {rewards.isError ? (
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {copy.claims.allRewardsUnavailable}
        </p>
      ) : null}
      {vpfi.isError ? (
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {copy.claims.allVpfiUnavailable}
        </p>
      ) : null}
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        {copy.claims.allResidualNote}
      </p>
      {[...legRouteNotes].map((note) => (
        <p key={note} className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {note}
        </p>
      ))}
      {rewardsToVaultNote ? (
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {rewardsToVaultNote}
        </p>
      ) : null}
      {vpfiLegBlocked ? (
        <p className="muted" role="status" style={{ marginTop: 0, fontSize: 13 }}>
          {vpfiWithdrawal.kind === 'queueFull'
            ? copy.vpfi.withdrawQueueFull
            : vpfiWithdrawal.kind === 'unread'
              ? copy.vpfi.withdrawProtectionUnknown
              : copy.vpfi.withdrawProtectionBlocked}
        </p>
      ) : null}

      {tooMany ? (
        <div className="banner banner-warning" role="alert">
          <span className="banner-body">
            {copy.claims.allTooMany(MAX_CLAIM_ALL)}
          </span>
        </div>
      ) : null}
      {outcomeNote ? (
        <div className="banner banner-info" role="status">
          <span className="banner-body">{outcomeNote}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}

      <button
        type="button"
        className="btn btn-primary"
        disabled={!canSubmit}
        onClick={() => void submit()}
      >
        {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
        {busy
          ? copy.claims.allWorking
          : selectedCount === 0
            ? copy.claims.allEmpty
            : copy.claims.allButton(selectedCount)}
      </button>
    </section>
  );
}

/** The windowed include/exclude checklist — a whale with dozens of
 *  claimable loans renders a page at a time, not every checkbox at
 *  once (matches the Claims row list's PAG-003 windowing). */
function ClaimAllChecklist({
  items,
  isSelected,
  onToggle,
  disabled,
}: {
  items: ReturnType<typeof buildClaimAllItems>;
  isSelected: (key: string) => boolean;
  onToggle: (key: string) => void;
  disabled: boolean;
}) {
  const resetKey = items.map((i) => i.key).join('|');
  const { shown, hasMore, hiddenCount, nextCount, loadMore } = useVisibleWindow(
    items,
    resetKey,
  );
  return (
    <>
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: '0 0 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {shown.map((item) => (
          <li key={item.key}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={isSelected(item.key)}
                onChange={() => onToggle(item.key)}
                disabled={disabled}
              />
              {item.loan ? <LoanItemLabel loan={item.loan} /> : <span>{item.label}</span>}
            </label>
          </li>
        ))}
      </ul>
      <div style={{ marginBottom: 12 }}>
        <ShowMoreButton
          hasMore={hasMore}
          hiddenCount={hiddenCount}
          nextCount={nextCount}
          onClick={loadMore}
        />
      </div>
    </>
  );
}

/** A loan item's checklist label, stating the payout the same way the
 *  claim row below does (UX3-004 — it used to say "your proceeds").
 *  Its own component because the payout text reads token metadata, which
 *  is a hook and so cannot run inside the pure item builder. */
function LoanItemLabel({ loan }: { loan: ClaimableLoan }) {
  const { what, note, provisional } = useClaimPayoutText(loan);
  const isRental = loan.assetType !== AssetType.ERC20;
  return (
    <span>
      {copy.claimAll.itemLabel(
        isRental ? copy.claimAll.rentalNoun : copy.claimAll.loanNoun,
        loan.loanId,
        what,
      )}
      {/* #2373 r6 — a payout the claim can still change carries its reason
          on every surface that states it, not only on the loan page. */}
      {provisional && note ? <span className="claim-payout-note">{note}</span> : null}
    </span>
  );
}
