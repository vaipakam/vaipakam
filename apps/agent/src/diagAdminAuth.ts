/**
 * 2026-05-17 — T-075: protocol-admin authentication for the
 * diagnostics legal-hold endpoint.
 *
 * The legal-hold endpoint (`POST /diag/legal-hold`) is operator-only.
 * Rather than gate it on a shared bearer secret — one more credential
 * to provision, rotate and risk leaking — it authenticates the
 * caller the same way the rest of the protocol's admin surface does:
 * the request is signed by a wallet, and that wallet must hold the
 * on-chain `ADMIN_ROLE` on the Diamond.
 *
 * This is the exact check `apps/defi`'s protocol console already runs
 * client-side (`useIsProtocolAdmin.ts` →
 * `AccessControlFacet.hasRole(ADMIN_ROLE, addr)`). Doing it here, on
 * the Worker, makes it a real authorization gate (the client-side
 * version is only a UI affordance): the contract's access-control
 * state is the single source of truth for "who is an admin", so
 * there is no separate admin list to keep in sync and no shared
 * secret in the Worker's env.
 */

import {
  createPublicClient,
  http,
  keccak256,
  toBytes,
  type Abi,
} from 'viem';
import { getChainConfigs, type Env } from './env';

/** `keccak256("ADMIN_ROLE")` — mirrors `LibAccessControl.ADMIN_ROLE`
 *  and the frontend's `useIsProtocolAdmin` constant. */
const ADMIN_ROLE = keccak256(toBytes('ADMIN_ROLE'));

/** Minimal `hasRole` view ABI — all the on-chain check needs. */
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

/**
 * True iff `address` holds the on-chain `ADMIN_ROLE` on the Vaipakam
 * Diamond of at least one configured chain.
 *
 * Checks every chain in `getChainConfigs(env)` and returns true on
 * the first hit — the protocol admin is normally the same wallet
 * across deployments, and a legal hold concerns off-chain D1 data so
 * is not chain-specific. A per-chain RPC failure or a missing
 * `AccessControlFacet` is swallowed and the next chain is tried; if
 * no chain confirms the role (including when no chains are
 * configured at all — the natural pre-deploy state), the result is
 * `false` and the caller is treated as unauthorized.
 */
export async function isProtocolAdmin(
  env: Env,
  address: string,
): Promise<boolean> {
  for (const chain of getChainConfigs(env)) {
    try {
      const client = createPublicClient({ transport: http(chain.rpc) });
      const hasRole = await client.readContract({
        address: chain.diamond as `0x${string}`,
        abi: HAS_ROLE_ABI,
        functionName: 'hasRole',
        args: [ADMIN_ROLE, address as `0x${string}`],
      });
      if (hasRole === true) return true;
    } catch {
      // RPC down, facet absent on this chain, transient error —
      // fall through and try the next configured chain.
    }
  }
  return false;
}

/** The function shape `handleDiagLegalHold` depends on, so tests can
 *  inject a stub instead of standing up an RPC mock. */
export type AdminVerifier = (env: Env, address: string) => Promise<boolean>;
