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
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!address || !isCorrectChain || !chain.diamondAddress) {
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await client.readContract({
          address: chain.diamondAddress as `0x${string}`,
          abi: HAS_ROLE_ABI,
          functionName: 'hasRole',
          args: [ADMIN_ROLE, address],
        });
        if (!cancelled) setIsAdmin(Boolean(result));
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, isCorrectChain, chain.diamondAddress, client]);

  return isAdmin;
}
