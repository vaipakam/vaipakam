import { useEffect, useState, useCallback } from 'react';
import { useReadyDiamond, useDiamondContract } from '../contracts/useDiamond';
import { decodeContractError } from '@vaipakam/lib/decodeContractError';
import { beginStep } from '../lib/journeyLog';

/**
 * Detects and drives the mandatory-upgrade flow for a user's per-user vault.
 *
 * Per README §"Vault Upgrades" (lines 960, 1100), a governance call to
 * `setMandatoryVaultUpgrade` can raise the required floor above a user's
 * current version. Until they upgrade, `getOrCreateUserVault` reverts
 * `VaultUpgradeRequired()`, which blocks every diamond flow that touches
 * their vault (offer creation, loan initiation, repay, claim, etc.).
 *
 * The contract exposes `getVaultVersionInfo(user)` so the frontend can
 * render the banner + action before the user hits a revert, and
 * `upgradeUserVault(user)` is callable by anyone — typically the user.
 */
export interface VaultVersionInfo {
  userVersion: bigint;
  currentVersion: bigint;
  mandatoryVersion: bigint;
  upgradeRequired: boolean;
}

export function useVaultUpgrade(address: string | null | undefined) {
  const diamondRead = useReadyDiamond();
  const diamond = useDiamondContract();
  const [info, setInfo] = useState<VaultVersionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) {
      setInfo(null);
      return;
    }
    if (!diamondRead) {
      // No Diamond on this chain — leave info=null; the upgrade banner
      // won't render and the upgrade button won't be reachable.
      setInfo(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await diamondRead.getVaultVersionInfo(address);
      setInfo({
        userVersion: res[0] as bigint,
        currentVersion: res[1] as bigint,
        mandatoryVersion: res[2] as bigint,
        upgradeRequired: res[3] as boolean,
      });
    } catch (err) {
      // View fn would only revert if the facet selector is missing — not
      // fatal for the rest of the app, but worth surfacing.
      setError(err instanceof Error ? err.message : 'Failed to read vault version');
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, [address, diamondRead]);

  useEffect(() => { load(); }, [load]);

  const upgrade = useCallback(async () => {
    if (!address) return;
    setError(null);
    setTxHash(null);
    setUpgrading(true);
    const s = beginStep({ area: 'vault-upgrade', flow: 'upgradeUserVault', step: 'submit-tx', wallet: address });
    try {
      const tx = await diamond.upgradeUserVault(address);
      setTxHash(tx.hash);
      await tx.wait();
      await load();
      s.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setError(decodeContractError(err, 'Vault upgrade failed'));
      s.failure(err);
    } finally {
      setUpgrading(false);
    }
  }, [address, diamond, load]);

  return { info, loading, upgrading, error, txHash, reload: load, upgrade };
}
