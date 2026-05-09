import { useEffect, useState, useCallback } from 'react';
import { useDiamondRead, useDiamondContract } from '../contracts/useDiamond';
import { decodeContractError } from '../lib/decodeContractError';
import { beginStep } from '../lib/journeyLog';

/**
 * Detects and drives the mandatory-upgrade flow for a user's per-user escrow.
 *
 * Per README §"Escrow Upgrades" (lines 960, 1100), a governance call to
 * `setMandatoryEscrowUpgrade` can raise the required floor above a user's
 * current version. Until they upgrade, `getOrCreateUserEscrow` reverts
 * `EscrowUpgradeRequired()`, which blocks every diamond flow that touches
 * their escrow (offer creation, loan initiation, repay, claim, etc.).
 *
 * The contract exposes `getEscrowVersionInfo(user)` so the frontend can
 * render the banner + action before the user hits a revert, and
 * `upgradeUserEscrow(user)` is callable by anyone — typically the user.
 */
export interface EscrowVersionInfo {
  userVersion: bigint;
  currentVersion: bigint;
  mandatoryVersion: bigint;
  upgradeRequired: boolean;
}

export function useEscrowUpgrade(address: string | null | undefined) {
  const diamondRead = useDiamondRead();
  const diamond = useDiamondContract();
  const [info, setInfo] = useState<EscrowVersionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) {
      setInfo(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await diamondRead.getEscrowVersionInfo(address);
      setInfo({
        userVersion: res[0] as bigint,
        currentVersion: res[1] as bigint,
        mandatoryVersion: res[2] as bigint,
        upgradeRequired: res[3] as boolean,
      });
    } catch (err) {
      // View fn would only revert if the facet selector is missing — not
      // fatal for the rest of the app, but worth surfacing.
      setError(err instanceof Error ? err.message : 'Failed to read escrow version');
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
    const s = beginStep({ area: 'escrow-upgrade', flow: 'upgradeUserEscrow', step: 'submit-tx', wallet: address });
    try {
      const tx = await diamond.upgradeUserEscrow(address);
      setTxHash(tx.hash);
      await tx.wait();
      await load();
      s.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setError(decodeContractError(err, 'Escrow upgrade failed'));
      s.failure(err);
    } finally {
      setUpgrading(false);
    }
  }, [address, diamond, load]);

  return { info, loading, upgrading, error, txHash, reload: load, upgrade };
}
