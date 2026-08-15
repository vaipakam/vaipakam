/**
 * T-042 Phase 4 — protocol-admin wallet detection (formerly
 * `useIsAdminWallet`; renamed 2026-05-02 alongside the Admin
 * Console → Protocol Console rebrand for consistency).
 *
 * Reads `AccessControlFacet.hasRole(ADMIN_ROLE, address)` on the
 * diamond and returns `true` when the connected wallet holds the
 * canonical contract `ADMIN_ROLE`. Drives:
 *   - Auto-engage of the terminal/mission-control theme when a
 *     protocol-admin wallet connects (`AdminDashboard.tsx`).
 *   - Visibility of the "Propose change" buttons on each knob card.
 *   - The in-app sidebar's "Protocol Console" entry visibility.
 *
 * Naming clarification: the on-chain role is `ADMIN_ROLE` (constant
 * name on `LibAccessControl`). The hook exposes that role check
 * under the "protocol admin" alias so that consumer code reads as
 * "is this wallet a protocol admin?" rather than "is this wallet a
 * generic admin?" — the hook is purely about the contract role,
 * not about any frontend account-management notion.
 *
 * Trust model: this is a UI-affordance check, not a security gate.
 * The contract ALWAYS enforces role on every state-changing setter
 * regardless of what the frontend thinks. A spoofed wallet that
 * appears admin-coloured to the UI cannot actually move state — the
 * setter reverts. We use this hook only to decide "should we render
 * the propose buttons?" — bypassing it would just render dead
 * buttons that revert on click.
 *
 * Soft-fail policy: read failure (RPC down, missing facet on the
 * read chain, ABI mismatch) returns `false`. Better to hide the
 * propose buttons than to flash them in a state where they don't
 * actually work.
 */

import { useEffect, useState } from 'react';
import { keccak256, toBytes, type Abi } from 'viem';
import { useWallet } from '../context/WalletContext';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';

/** Pre-computed `keccak256("ADMIN_ROLE")` to avoid recomputing on
 *  every hook invocation. Mirrors `LibAccessControl.ADMIN_ROLE`. */
const ADMIN_ROLE = keccak256(toBytes('ADMIN_ROLE'));

/** Minimal `hasRole` ABI — sufficient for read-only access checks
 *  without pulling the full AccessControlFacet bundle into the
 *  dashboard's surface. */
const HAS_ROLE_ABI: Abi = [
  {
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    name: 'hasRole',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
];

export function useIsProtocolAdmin(): boolean {
  const { address, isCorrectChain } = useWallet();
  const client = useDiamondPublicClient();
  const chain = useReadChain();
  // Tagged with chain + wallet, and `false` is DERIVED. This hook gates admin
  // UI, so the direction of the stale frame is the one that matters: after
  // disconnecting or switching to a chain where the wallet holds no role, the
  // effect's reset arrives a paint LATE and admin controls are briefly on
  // screen for someone who no longer has the role. Deriving means the answer
  // is never shown for a question other than the one asked. (The on-chain role
  // check remains the real boundary — this is UI.)
  const reqKey =
    address && isCorrectChain && chain.diamondAddress
      ? `${chain.chainId}|${chain.diamondAddress.toLowerCase()}|${address.toLowerCase()}`
      : null;
  const [result, setResult] = useState<{ key: string; isAdmin: boolean } | null>(null);

  useEffect(() => {
    if (!reqKey || !address || !chain.diamondAddress) return;
    let cancelled = false;
    (async () => {
      let next = false;
      try {
        next = Boolean(
          await client.readContract({
            address: chain.diamondAddress as `0x${string}`,
            abi: HAS_ROLE_ABI,
            functionName: 'hasRole',
            args: [ADMIN_ROLE, address],
          }),
        );
      } catch {
        next = false;
      }
      if (!cancelled) setResult({ key: reqKey, isAdmin: next });
    })();
    return () => {
      cancelled = true;
      // Dropped on the way out — reconnecting the same wallet must re-check
      // rather than reuse a verdict granted before the disconnect.
      setResult(null);
    };
  }, [address, isCorrectChain, chain.chainId, chain.diamondAddress, client, reqKey]);

  return result?.key === reqKey && result.isAdmin;
}
