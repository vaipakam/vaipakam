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
import { useVpfi } from '../data/vpfi';
import { assertWalletNotSanctionedLive, useSanctionsCheck } from '../data/sanctions';
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
  // Cached screen for the disabled state; the live fail-closed re-read
  // below is the load-bearing gate at submit time.
  const sanctions = useSanctionsCheck();
  const sanctionsClear = sanctions.ready && !sanctions.flagged;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  }

  // Wait for rewards + vault VPFI to SETTLE before offering the batch:
  // a still-loading read defaults its amount to 0n, which would silently
  // drop that leg from a batch the user thinks is complete.
  if (rewards.isPending || vpfi.isPending) return null;

  const items = buildClaimAllItems({
    loans,
    rewardsPending: rewards.data?.pending ?? 0n,
    vpfiFree: vpfi.data?.freeBalance ?? 0n,
  });

  // The batch only makes sense for two or more payouts — a single claim
  // already has its own button/row. (Claims.tsx suppresses the "no
  // claims yet" empty state when there ARE non-loan payouts, so a pure
  // rewards+vault batch no longer contradicts it — Codex #1291 r1.)
  if (items.length < 2) return null;

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
  const tooMany = selectedCount > MAX_CLAIM_ALL;
  const canSubmit =
    !busy &&
    onSupportedChain &&
    sanctionsClear &&
    selectedCount > 0 &&
    !tooMany;

  function toggle(key: string) {
    const now = isSelected(key);
    setOverrides((prev) => ({ ...prev, [key]: !now }));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (!address || !walletChain || !publicClient) {
        throw new Error(copy.wallet.connectFirst);
      }
      // The batch can include claimInteractionRewards (and fund-out
      // claim/withdraw paths). Re-read the oracle live and fail CLOSED —
      // an unreadable oracle blocks rather than waving a flagged wallet
      // through (same posture as the standalone rewards button).
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
        { failClosed: true },
      );
      const chosen = items.filter((i) => isSelected(i.key));
      if (chosen.length === 0) return;
      const calls = encodeClaimAllCalls(chosen);
      await write('multicall', [calls]);
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

      {tooMany ? (
        <div className="banner banner-warning" role="alert">
          <span className="banner-body">
            {copy.claims.allTooMany(MAX_CLAIM_ALL)}
          </span>
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
              <span>{item.label}</span>
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
