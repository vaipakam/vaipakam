import { useState } from 'react';
import { useWalletClient } from 'wagmi';
import { Coins, Clock, ArrowRight, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../../context/WalletContext';
import { useDiamondPublicClient, useReadChain } from '../../contracts/useDiamond';
import { getCanonicalVPFIChain } from '../../contracts/config';
import {
  useVPFIDiscountConsent,
  useVPFIDiscountTier,
} from '../../hooks/useVPFIDiscount';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
import { L as Link } from '../L';

/**
 * T-087 Sub 4 phase 2 — chain-agnostic "Stake VPFI" surface.
 *
 * Renders on the dashboard regardless of which chain the user is on:
 *
 *   - On a MIRROR chain: "Managed on Base" footnote + one-click
 *     switch-to-Base button. The actual stake action lives on the
 *     canonical chain; we don't try to surface a fake "stake here"
 *     button on mirrors.
 *
 *   - On the CANONICAL chain (Base): "Stake VPFI" CTA linking to the
 *     buy-VPFI page where the user can buy + deposit in one flow.
 *
 *   - When the user has a TRACKED stake but their EFFECTIVE_TIER is
 *     still 0 (min-history pending), surfaces a "Push my tier to
 *     mirrors now" CTA wired to `pokeMyTier()`. The button is
 *     informational on non-canonical chains (greyed; switch-first).
 *
 * Intentionally lightweight — no balance reads beyond what
 * `useVPFIDiscountTier` already provides. The card is hidden when
 * neither stake action nor tier-pending state applies, so it doesn't
 * crowd the dashboard for users who already have a settled tier.
 */
export function StakeVPFICTA() {
  const { t } = useTranslation();
  const { address, switchToChain } = useWallet();
  const chain = useReadChain();
  const isCanonical = chain.isCanonicalVPFI === true;
  // Defaults to the testnet/mainnet bucket aligned with the
  // configured DEFAULT_CHAIN. Works on both prod + dev builds.
  const canonicalChain = getCanonicalVPFIChain();

  const lenderAddr = (address ?? null) as `0x${string}` | null;
  const { data: tierData, reload: reloadTier } =
    useVPFIDiscountTier(lenderAddr);
  const { enabled: consentEnabled } = useVPFIDiscountConsent();

  const { data: walletClient } = useWalletClient();
  const publicClient = useDiamondPublicClient();
  const [poking, setPoking] = useState(false);
  const [pokeError, setPokeError] = useState<string | null>(null);

  // A user is in "min-history pending" if they've staked through the
  // tracked-balance path (trackedTier > 0) AND consent is on AND
  // effective tier is still 0. The poke CTA fires `pokeMyTier()`
  // which forces a rollup + broadcast.
  const minHistoryPending =
    (tierData?.trackedTier ?? 0) > 0 &&
    (tierData?.tier ?? 0) === 0 &&
    consentEnabled === true;

  // The card surfaces only when there's something for the user to do.
  // If they're on canonical with consent OK and a settled tier, the
  // card stays hidden so the dashboard isn't cluttered.
  const showCard =
    !isCanonical || minHistoryPending || (tierData?.trackedBal ?? 0n) === 0n;

  if (!showCard) return null;

  const switchToBase = async () => {
    if (!canonicalChain) return;
    await switchToChain(canonicalChain.chainId);
  };

  const handlePoke = async () => {
    if (!walletClient || !chain.diamondAddress) return;
    setPokeError(null);
    setPoking(true);
    try {
      const hash = await walletClient.writeContract({
        address: chain.diamondAddress as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: 'pokeMyTier',
        args: [],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await reloadTier();
    } catch (e) {
      setPokeError(
        e instanceof Error ? e.message : 'Tier poke failed',
      );
    } finally {
      setPoking(false);
    }
  };

  return (
    <div className="card stake-vpfi-cta">
      <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Coins size={14} />
        {t('stakeVpfiCta.title')}
      </div>

      {!isCanonical && (
        <div style={{ marginTop: 8 }}>
          <div className="card-subtitle">
            {t('stakeVpfiCta.managedOnBaseSubtitle', {
              canonicalName: canonicalChain?.name ?? 'Base',
            })}
          </div>
          <button
            type="button"
            className="btn primary"
            onClick={switchToBase}
            style={{ marginTop: 8 }}
          >
            {t('stakeVpfiCta.switchToBaseLabel', {
              canonicalName: canonicalChain?.name ?? 'Base',
            })}
            <ArrowRight size={14} style={{ marginLeft: 6, verticalAlign: 'middle' }} />
          </button>
        </div>
      )}

      {isCanonical && (tierData?.trackedBal ?? 0n) === 0n && (
        <div style={{ marginTop: 8 }}>
          <div className="card-subtitle">
            {t('stakeVpfiCta.noStakeYetBody')}
          </div>
          <Link
            to="/buy-vpfi"
            className="btn primary"
            style={{ marginTop: 8, display: 'inline-block' }}
          >
            {t('stakeVpfiCta.stakeNowLabel')}
            <ArrowRight size={14} style={{ marginLeft: 6, verticalAlign: 'middle' }} />
          </Link>
        </div>
      )}

      {isCanonical && minHistoryPending && (
        <div style={{ marginTop: 8 }}>
          <div
            className="alert alert-info"
            role="status"
            style={{ marginBottom: 8 }}
          >
            <Clock size={14} />
            <div>
              <strong>{t('stakeVpfiCta.tierPendingTitle')}</strong>
              <br />
              {t('stakeVpfiCta.tierPendingBody')}
            </div>
          </div>
          <button
            type="button"
            className="btn"
            onClick={handlePoke}
            disabled={poking}
          >
            {poking
              ? t('stakeVpfiCta.pokeButtonPending')
              : t('stakeVpfiCta.pokeButtonIdle')}
          </button>
          {pokeError && (
            <div
              className="alert alert-warning"
              role="status"
              style={{ marginTop: 8 }}
            >
              <AlertTriangle size={14} />
              <div>{pokeError}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
