import { useEffect, useState } from 'react';
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
  const { address, chainId: walletChainId, switchToChain } = useWallet();
  const chain = useReadChain();
  const isCanonical = chain.isCanonicalVPFI === true;
  // Codex round-1 P2 #1 — pick the canonical preference (mainnet vs
  // testnet) from the user's CURRENT read chain, not from
  // DEFAULT_CHAIN. On a mainnet-default build a user reading from
  // Sepolia would otherwise be told to switch to Base mainnet.
  const canonicalChain = getCanonicalVPFIChain(
    chain.testnet ? 'testnet' : 'mainnet',
  );

  const lenderAddr = (address ?? null) as `0x${string}` | null;
  const { data: tierData, reload: reloadTier } =
    useVPFIDiscountTier(lenderAddr);
  const { enabled: consentEnabled, reload: reloadConsent } =
    useVPFIDiscountConsent();

  // Codex round-2 P2 #2 — the consent + tier hooks are local-state
  // reads; toggling consent in the sibling VPFIDiscountConsentCard
  // doesn't propagate back to this hook instance. Poll on a short
  // interval while mounted so the CTA reflects consent / tier
  // changes from elsewhere on the page without the user having to
  // refresh. 5s is the same cadence the wallet+chain context uses.
  useEffect(() => {
    if (!address) return;
    const id = window.setInterval(() => {
      void reloadConsent();
      void reloadTier();
    }, 5000);
    return () => window.clearInterval(id);
  }, [address, reloadConsent, reloadTier]);

  const { data: walletClient } = useWalletClient();
  const publicClient = useDiamondPublicClient();
  const [poking, setPoking] = useState(false);
  const [pokeError, setPokeError] = useState<string | null>(null);

  // Codex round-1 P2 #4 — the poke button is USEFUL once the user
  // has a NON-ZERO effective tier (post-min-history) and wants to
  // ensure mirrors got the update. During the min-history window
  // itself, poking just re-rolls a tier-0 broadcast that doesn't
  // help the user. The button now surfaces when:
  //   - The user has a settled effective tier (> 0).
  //   - Consent is on (else the broadcast pushes 0 anyway).
  //   - The user is on the canonical chain (the wallet AND read
  //     contexts both line up, see `canPokeHere`).
  const tierReadyToBroadcast =
    (tierData?.tier ?? 0) > 0 && consentEnabled === true;

  // Codex round-1 P2 #2 — the poke writeContract goes to the wallet's
  // CURRENT chain. We must only show the button when the wallet and
  // the read context both agree on the canonical chain; otherwise
  // the user would dispatch the tx on a mirror Diamond that doesn't
  // have `pokeMyTier`, OR the receipt-wait would target the wrong
  // chain.
  const canPokeHere =
    isCanonical &&
    canonicalChain != null &&
    walletChainId === canonicalChain.chainId;

  // The card surfaces only when there's something for the user to do.
  // Codex round-2 P2 #1 — additionally gate on `address != null` so
  // a disconnected dashboard stays hidden (matches the release-note
  // promise; without this the no-stake branch would always fire
  // because `trackedBal ?? 0n === 0n` while no read happens).
  const showCard =
    address != null &&
    (!isCanonical
      || (canPokeHere && tierReadyToBroadcast)
      || (tierData?.trackedBal ?? 0n) === 0n);

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
      // Codex round-1 P2 #3 — viem's waitForTransactionReceipt
      // resolves on inclusion regardless of `status`. A reverted
      // poke (paused diamond / broadcast budget exhausted / etc.)
      // would otherwise silently fall through to reloadTier() and
      // leave the user with no error feedback. Surface the revert.
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error('Transaction reverted on-chain');
      }
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
            className="btn btn-primary"
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
            className="btn btn-primary"
            style={{ marginTop: 8, display: 'inline-block' }}
          >
            {t('stakeVpfiCta.stakeNowLabel')}
            <ArrowRight size={14} style={{ marginLeft: 6, verticalAlign: 'middle' }} />
          </Link>
        </div>
      )}

      {canPokeHere && tierReadyToBroadcast && (
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
