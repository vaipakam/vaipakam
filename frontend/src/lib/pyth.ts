import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  parseAbi,
} from 'viem';

/**
 * Pyth Hermes fetch + on-chain update helper (Phase 3.2).
 *
 * Pyth is a pull oracle: its on-chain state only refreshes when someone
 * submits a signed update payload from Pyth's off-chain network (Hermes).
 * For price-reading Vaipakam actions (initiateLoan, triggerLiquidation,
 * etc.), the frontend submits two sequential transactions from the same
 * EOA in nonce order:
 *   Tx 1 — IPyth(endpoint).updatePriceFeeds{value: fee}(updateData)
 *   Tx 2 — the Diamond action
 *
 * Same EOA + same block = nonce-ordered delivery, so Pyth's stored
 * price cannot stale out between the two. This matches the pattern
 * used by every major Pyth-integrated protocol.
 */

/** Hermes public endpoint. Pyth runs additional mirrors; one is enough
 *  for our latency budget. */
const HERMES_BASE_URL = 'https://hermes.pyth.network';

/** Minimal ABI slice of the Pyth contract — only what the update call
 *  needs. Full interface lives on-chain. */
const PYTH_ABI = parseAbi([
  'function getUpdateFee(bytes[] updateData) view returns (uint256)',
  'function updatePriceFeeds(bytes[] updateData) payable',
]);

export interface PythUpdatePlan {
  /** Hex-encoded signed update payloads, one per requested feed id. */
  updateData: Hex[];
  /** Fee (in wei) the caller must pay to `IPyth.updatePriceFeeds`. */
  fee: bigint;
  /** Feed ids included in `updateData`, in the same order. */
  feedIds: Hex[];
}

/**
 * Fetch the latest signed VAAs (verifiable action approvals) for a set
 * of Pyth price feeds from Hermes, and quote the on-chain update fee.
 *
 * Hermes responds with base64-encoded VAA strings; we concat the 0x
 * prefix + hex-encoded bytes so the payload is directly accepted by
 * `IPyth.updatePriceFeeds`.
 *
 * @param feedIds     Pyth price feed ids to update (32-byte hex each,
 *                    e.g. ETH/USD = 0xff6149...).
 * @param publicClient Viem client bound to the target chain — used to
 *                    read the on-chain update fee quote.
 * @param pythEndpoint Pyth contract address on the target chain.
 * @returns           An update plan ready to submit via {submitPythUpdate}.
 */
export async function buildPythUpdatePlan(
  feedIds: Hex[],
  publicClient: PublicClient,
  pythEndpoint: Address,
): Promise<PythUpdatePlan> {
  if (feedIds.length === 0) {
    return { updateData: [], fee: 0n, feedIds: [] };
  }

  // Hermes encodes the VAAs as binary data returned in a URL-safe
  // base64 string. The `encoding=hex` query param gives us raw hex
  // that viem can feed directly into the update call.
  const query = new URLSearchParams();
  for (const id of feedIds) {
    // Hermes expects ids WITHOUT the 0x prefix.
    query.append('ids[]', id.startsWith('0x') ? id.slice(2) : id);
  }
  query.append('encoding', 'hex');

  const url = `${HERMES_BASE_URL}/v2/updates/price/latest?${query.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Hermes fetch failed: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as {
    binary?: { encoding?: string; data?: string[] };
  };
  const encoded = body.binary?.data ?? [];
  if (encoded.length === 0) {
    throw new Error('Hermes returned no update data for the requested feeds');
  }

  // Hermes returns each VAA as a 0x-prefixed hex string when
  // `encoding=hex`. Some response shapes omit the prefix; normalise.
  const updateData = encoded.map((d) =>
    (d.startsWith('0x') ? d : `0x${d}`) as Hex,
  );

  const fee = (await publicClient.readContract({
    address: pythEndpoint,
    abi: PYTH_ABI,
    functionName: 'getUpdateFee',
    args: [updateData],
  })) as bigint;

  return { updateData, fee, feedIds };
}

/**
 * Submit the update transaction that primes Pyth's on-chain storage.
 * Returns the tx hash — the caller's follow-up Diamond action should
 * wait for inclusion (or just send the next tx with nonce+1; both
 * land in the same block when routed through a sensible public
 * mempool).
 *
 * @param plan          Update plan from {buildPythUpdatePlan}.
 * @param pythEndpoint  Pyth contract address on the target chain.
 * @param walletClient  Viem wallet client (the user's connected wallet).
 * @param publicClient  Viem public client, for chain + account context.
 * @returns             The tx hash of the `updatePriceFeeds` call.
 */
export async function submitPythUpdate(
  plan: PythUpdatePlan,
  pythEndpoint: Address,
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<Hex> {
  if (plan.updateData.length === 0) {
    throw new Error('Empty update plan — nothing to submit');
  }
  if (!walletClient.account) {
    throw new Error('Wallet client has no connected account');
  }

  const hash = await walletClient.writeContract({
    address: pythEndpoint,
    abi: PYTH_ABI,
    functionName: 'updatePriceFeeds',
    args: [plan.updateData],
    value: plan.fee,
    account: walletClient.account,
    chain: walletClient.chain,
  });

  // Wait for inclusion before the caller's follow-up tx. Sequential
  // nonce delivery on the same block wouldn't strictly need this, but
  // the explicit wait lets the caller surface a "price updated"
  // confirmation before asking the user to sign the second tx.
  await publicClient.waitForTransactionReceipt({ hash });

  return hash;
}
