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
 */
import { useEffect, useMemo, useState } from 'react';
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
  encodeClaimAllCalls,
  MAX_CLAIM_ALL,
} from '../data/claimAll';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { captureTxError } from '../lib/errors';

export function ClaimAllCard({ loans }: { loans: ClaimableLoan[] }) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
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

  const items = useMemo(
    () =>
      buildClaimAllItems({
        loans,
        rewardsPending: rewards.data?.pending ?? 0n,
        vpfiFree: vpfi.data?.freeBalance ?? 0n,
      }),
    [loans, rewards.data?.pending, vpfi.data?.freeBalance],
  );

  // Reset the selection to the item defaults only when the item SET
  // changes (keys), not when an amount refreshes — so a user's manual
  // toggle survives a background balance re-read, but a claimed item
  // leaving the batch re-seeds cleanly.
  const itemsKey = items.map((i) => i.key).join('|');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(
      new Set(items.filter((i) => i.defaultSelected).map((i) => i.key)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  // The batch only makes sense for two or more payouts — a single claim
  // already has its own button/row.
  if (items.length < 2) return null;

  const hasVpfiVault = items.some((i) => i.kind === 'vpfi-vault');
  const tooMany = selected.size > MAX_CLAIM_ALL;
  const canSubmit =
    !busy &&
    onSupportedChain &&
    sanctionsClear &&
    selected.size > 0 &&
    !tooMany;

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
      const chosen = items.filter((i) => selected.has(i.key));
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
        {items.map((item) => (
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
                checked={selected.has(item.key)}
                onChange={() => toggle(item.key)}
                disabled={busy}
              />
              <span>{item.label}</span>
            </label>
          </li>
        ))}
      </ul>

      {hasVpfiVault ? (
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {copy.claims.allVpfiNote}
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
          : selected.size === 0
            ? copy.claims.allEmpty
            : copy.claims.allButton(selected.size)}
      </button>
    </section>
  );
}
