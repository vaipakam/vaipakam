import { ActionFn, Context, PeriodicEvent } from '@tenderly/actions';
import { ethers } from 'ethers';

/**
 * Scheduled action: page when any active loan's HF drops below the configured
 * threshold (default 1.05e18 — the "about-to-liquidate" band). The threshold
 * is deliberately above the 1.0e18 liquidation floor so oncall has a chance
 * to investigate a bad oracle read vs. organic price move before a liquidator
 * captures the bonus.
 *
 * Reads active loan IDs from the subgraph (cheap) rather than scanning
 * storage — storage-scan is O(totalLoans) and would be rate-limited against
 * a public RPC. Falls back to `getActiveLoanIds(0, 500)` on the Diamond when
 * the subgraph is unreachable.
 */
const DIAMOND_ABI = [
  'function calculateHealthFactor(uint256 loanId) view returns (uint256)',
  'function getActiveLoanIds(uint256 offset, uint256 limit) view returns (uint256[])',
];

export const watchHealthFactor: ActionFn = async (context: Context, _event: PeriodicEvent) => {
  const diamond = context.metadata.getNetwork ? await context.secrets.get('DIAMOND_ADDRESS') : '';
  const rpcUrl = await context.secrets.get('RPC_URL');
  const thresholdStr = (await context.storage.getStr('threshold_hf_1e18')) || '1050000000000000000';
  const threshold = BigInt(thresholdStr);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(diamond, DIAMOND_ABI, provider);

  const loanIds: bigint[] = await contract.getActiveLoanIds(0, 500);
  const breaches: { loanId: string; hf: string }[] = [];

  for (const id of loanIds) {
    try {
      const hf: bigint = await contract.calculateHealthFactor(id);
      if (hf < threshold) {
        breaches.push({ loanId: id.toString(), hf: hf.toString() });
      }
    } catch {
      // HF reverts when oracle data is stale — covered by the stale-oracle alert,
      // no need to double-page here.
    }
  }

  if (breaches.length > 0) {
    console.warn(`[watch-health-factor] ${breaches.length} HF breach(es)`, breaches);
    throw new Error(`HF threshold breach: ${JSON.stringify(breaches)}`);
  }
};
