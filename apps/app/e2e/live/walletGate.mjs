/**
 * THE SIGNING GATE AT THE WALLET BOUNDARY (#2422 r4).
 *
 * `launch({ signingGate, pinnedChainId })` in driver.mjs runs every request
 * the page makes of the injected wallet through `walletGateDecision` BEFORE
 * the wallet acts on it — in the same Node-side handler that holds the key
 * and signs. A drive that passes a gate therefore cannot have it bypassed:
 *
 *   - there is no page-side wrapper to install, so no init-script ordering
 *     can leave a document's provider unwrapped (Playwright does not order
 *     `addInitScript` callbacks against each other);
 *   - the chain the wallet signs FOR is pinned here, not inferred: a page
 *     cannot `wallet_switchEthereumChain` to another configured chain and
 *     have a send whose calldata was judged for the pinned chain broadcast
 *     on a different live one — `eth_sendTransaction` normally omits
 *     `chainId`, so nothing in the payload itself would reveal the switch.
 *
 * Pure apart from the gate callback it is handed, so `walletGate.test.mjs`
 * pins every refusal without a browser or a key.
 *
 * The decision, in order:
 *   1. a chain switch or add to any chain other than `pinnedChainId` is
 *      refused (switching to the pinned chain itself is a no-op and passes);
 *   2. a signing method while the wallet's active chain is not the pinned
 *      one is refused, before the gate is even consulted;
 *   3. every signing method is put to the gate, and refused (EIP-1193 4001)
 *      unless the verdict is `{ ok: true }` — a missing, malformed or
 *      throwing verdict refuses, never allows;
 *   4. anything else (reads, account and chain queries) passes untouched.
 */

/** Every method that signs or sends. One list, so a method cannot be gated
 *  in one place and forgotten in another. */
export const GATED_METHODS = new Set([
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sendRawTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_sendCalls',
  'eth_sendUserOperation',
]);

/** Methods that change, or propose changing, the wallet's chain. */
export const CHAIN_METHODS = new Set(['wallet_switchEthereumChain', 'wallet_addEthereumChain']);

const USER_REJECTED = 4001; // EIP-1193

/**
 * @param {object} o
 * @param {string} o.method
 * @param {unknown[]} [o.params]
 * @param {number} o.activeChainId   the wallet's chain right now
 * @param {number} o.pinnedChainId   the only chain this wallet may act on
 * @param {string} [o.role]
 * @param {(method: string, params: unknown, ctx: {role?: string, chainId: number}) =>
 *          Promise<{ok: boolean, why?: string} & Record<string, unknown>>} o.gate
 * @returns {Promise<{ok: true, verdict: object|null} | {ok: false, code: number, why: string}>}
 */
export async function walletGateDecision({ method, params, activeChainId, pinnedChainId, role, gate }) {
  if (CHAIN_METHODS.has(method)) {
    const raw = params?.[0]?.chainId;
    const wanted = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
    if (wanted !== pinnedChainId) {
      return {
        ok: false,
        code: USER_REJECTED,
        why: `${method} to chain ${String(raw)} refused — this wallet is pinned to chain ${pinnedChainId}`,
      };
    }
    return { ok: true, verdict: null };
  }
  if (!GATED_METHODS.has(method)) return { ok: true, verdict: null };
  if (activeChainId !== pinnedChainId) {
    return {
      ok: false,
      code: USER_REJECTED,
      why: `${method} refused — the wallet is on chain ${activeChainId}, pinned to ${pinnedChainId}`,
    };
  }
  let verdict;
  try {
    verdict = await gate(method, params, { role, chainId: activeChainId });
  } catch (err) {
    return { ok: false, code: USER_REJECTED, why: `${method} refused — the signing gate threw: ${String(err?.message ?? err)}` };
  }
  if (!verdict || verdict.ok !== true) {
    return { ok: false, code: USER_REJECTED, why: `${method} refused by the signing gate: ${verdict?.why ?? 'no verdict'}` };
  }
  return { ok: true, verdict };
}
