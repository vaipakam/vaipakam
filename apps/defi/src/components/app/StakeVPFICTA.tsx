import { useEffect, useState } from 'react';
import { useWalletClient } from 'wagmi';
import { Coins, Clock, ArrowRight, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../../context/WalletContext';
import { useDiamondPublicClient, useReadChain } from '../../contracts/useDiamond';
import { CHAIN_REGISTRY } from '../../contracts/config';
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
  // Codex round-1 P2 #1 + round-3 P2 — pick a canonical that is
  // BOTH the right network AND actually deployed. The stock
  // `getCanonicalVPFIChain` doesn't filter by `diamondAddress`, so
  // on a wallet currently on a mainnet without a deployed Diamond
  // (e.g. Ethereum mainnet in a testnet-only build), the helper
  // would still return Base mainnet — switching the user to a chain
  // where staking can't work.
  //
  // Resolve inline: filter the registry by canonical + deployed,
  // prefer the same testnet/mainnet network as the read chain, fall
  // back to ANY deployed canonical so the CTA always has a target.
  const canonicalChain = (() => {
    const deployedCanonicals = Object.values(CHAIN_REGISTRY).filter(
      (c) => c.isCanonicalVPFI && c.diamondAddress !== null,
    );
    const matchingNetwork = deployedCanonicals.find(
      (c) => c.testnet === chain.testnet,
    );
    return matchingNetwork ?? deployedCanonicals[0] ?? null;
  })();

  const lenderAddr = (address ?? null) as `0x${string}` | null;
  const { data: tierData, reload: reloadTier } =
    useVPFIDiscountTier(lenderAddr);
  const { reload: reloadConsent } = useVPFIDiscountConsent();

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
  // Codex round-3 P3 #2 — after a successful poke, none of the
  // tier-related values change (tier was already > 0 — that was
  // the whole point of the broadcast). Without this flag the CTA
  // would stay visible and the user would keep firing no-op pokes
  // that burn protocol broadcast budget. Hide the CTA for 60s
  // after a success; after that the user can re-poke if they want
  // to ensure a fresh broadcast.
  const [recentlyPoked, setRecentlyPoked] = useState(false);
  useEffect(() => {
    if (!recentlyPoked) return;
    const id = window.setTimeout(() => setRecentlyPoked(false), 60_000);
    return () => window.clearTimeout(id);
  }, [recentlyPoked]);
  // Codex round-4 P3 #1 — reset the cooldown when the user switches
  // wallet account or chain. Otherwise a second account connected
  // within the 60s window wouldn't see the CTA even though it has
  // never poked.
  useEffect(() => {
    setRecentlyPoked(false);
  }, [address, walletChainId]);

  // Codex round-1 P2 #4 + round-5 P2 — the poke button is useful in
  // BOTH directions:
  //   - Consent on + trackedTier > 0: push the user's current
  //     non-zero tier so mirrors reflect the post-min-history
  //     activation.
  //   - Consent off + trackedTier > 0: push (0, 0) to mirrors to
  //     clear a stale cached tier. (The contract's
  //     `setVPFIDiscountConsent(false)` deliberately does NOT
  //     broadcast — anti-drain — and the docs ask the dapp to
  //     surface this poke chained after the consent toggle.)
  //
  // The minimal unified condition is `trackedTier > 0` — the user
  // has staked enough to qualify for a tier; whether they currently
  // have consent on or off, a fresh broadcast keeps mirrors in sync.
  // The on-chain de-dup gate in `ProtocolBroadcastFacet` suppresses
  // no-op repeats, so this is safe to surface broadly.
  const tierReadyToBroadcast = (tierData?.trackedTier ?? 0) > 0;

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
  // Codex round-2 P2 #1 — `address != null` so a disconnected
  // dashboard stays hidden.
  // Codex round-3 P3 #1 — only show the no-stake CTA AFTER
  // `useVPFIDiscountTier` has loaded (i.e., `tierData != null`).
  // Otherwise the canonical-chain branch fires for every connected
  // user during the initial RPC roundtrip, flashing the wrong CTA
  // for users who do have a stake.
  // Codex round-3 P3 #2 — suppress the poke branch when
  // `recentlyPoked` so a successful poke hides the CTA instead of
  // inviting a no-op repeat.
  // Codex round-4 P2 #1 — gate no-stake CTA on a DEPLOYED diamond
  // (`chain.diamondAddress != null`). Otherwise on a canonical
  // chain without a deployment in this bundle (e.g. Base mainnet
  // in a testnet-only build), the CTA would invite users to stake
  // on a non-existent Diamond.
  // Codex round-4 P2 #2 — also gate on the wallet ACTUALLY being
  // on a supported (read-chain-equal) chain. When the wallet is on
  // an unregistered network, `useReadChain` falls back to
  // DEFAULT_CHAIN; the user needs the switch CTA, not the stake
  // CTA.
  const walletOnReadChain = walletChainId === chain.chainId;
  const showNoStakeBranch =
    isCanonical &&
    chain.diamondAddress != null &&
    walletOnReadChain &&
    tierData != null &&
    tierData.trackedBal === 0n;
  const showPokeBranch =
    canPokeHere && tierReadyToBroadcast && !recentlyPoked;
  const showCard =
    address != null && (!isCanonical || showNoStakeBranch || showPokeBranch);

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
      setRecentlyPoked(true);
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

      {showNoStakeBranch && (
        <div style={{ marginTop: 8 }}>
          <div className="card-subtitle">
            {t('stakeVpfiCta.noStakeYetBody')}
          </div>
          <Link
            to="/vpfi-vault"
            className="btn btn-primary"
            style={{ marginTop: 8, display: 'inline-block' }}
          >
            {t('stakeVpfiCta.stakeNowLabel')}
            <ArrowRight size={14} style={{ marginLeft: 6, verticalAlign: 'middle' }} />
          </Link>
        </div>
      )}

      {showPokeBranch && (
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
