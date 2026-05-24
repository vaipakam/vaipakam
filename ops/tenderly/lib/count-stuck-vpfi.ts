import { ActionFn, Context, PeriodicEvent } from '@tenderly/actions';
import { ethers } from 'ethers';

/**
 * Scheduled action: alert when VpfiBuyReceiver.VPFIStuckForRetry events
 * exceed a threshold in the trailing 1h window. Each individual stuck VPFI
 * is recoverable via the two-step retry path, but a CLUSTER suggests
 * something systematically wrong upstream — buyer address mismatches, a
 * Diamond-side rejection that's hitting many requests, or a downstream
 * contract bug.
 *
 * Why a Web3 Action and not a per-event alert: a single stuck VPFI is
 * expected (retry path is the happy path for some racy delivery
 * scenarios — see VpfiBuyReceiver.sol comments). Paging on each one would
 * be noise. We want the RATE alarm, which Tenderly's native event filters
 * don't express.
 *
 * Threshold passed from alerts-crosschain.yaml via `params.threshold`
 * (default 3); operator can tune by editing the preset.
 *
 * Wired only on Base (where the receiver lives) — per
 * `alerts-crosschain.yaml` §F.
 */

const RECEIVER_ABI = [
  'event VPFIStuckForRetry(uint256 indexed messageId, address buyer, uint256 vpfiAmount, string reason)',
];

const ONE_HOUR_BLOCKS_BASE = 1800; // Base ~2-sec blocks → ~1800/hr.
// Adjust if applying this preset to a non-Base chain (other chain
// block times differ); kept as a constant rather than a per-chain
// derivation because today this action only runs on Base.

export const countStuckVpfi: ActionFn = async (
  context: Context,
  _event: PeriodicEvent,
) => {
  const receiverAddress =
    (await context.storage.getStr('VPFI_BUY_RECEIVER_ADDRESS')) ||
    (await context.secrets.get('VPFI_BUY_RECEIVER_ADDRESS'));
  const rpcUrl = await context.secrets.get('RPC_URL');
  const thresholdStr =
    (await context.storage.getStr('stuck_vpfi_threshold_per_hour')) || '3';
  const threshold = parseInt(thresholdStr, 10);

  if (!receiverAddress || !rpcUrl) {
    throw new Error(
      'count-stuck-vpfi: missing VPFI_BUY_RECEIVER_ADDRESS or RPC_URL secret',
    );
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(receiverAddress, RECEIVER_ABI, provider);

  // Scan the trailing hour for VPFIStuckForRetry events. Tenderly Actions
  // run on a serverless runtime with a tight CPU budget; the 1800-block
  // window is well within the eth_getLogs ceiling on Alchemy / QuickNode.
  // If we ever need larger windows or higher-volume chains, chunk the
  // request through the same multi-RPC failover pattern apps/keeper uses.
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - ONE_HOUR_BLOCKS_BASE);

  const filter = contract.filters.VPFIStuckForRetry();
  const events = await contract.queryFilter(filter, fromBlock, latest);

  console.log(
    `[count-stuck-vpfi] window=${fromBlock}..${latest} ` +
    `count=${events.length} threshold=${threshold}`,
  );

  if (events.length >= threshold) {
    // Construct the alert payload. Tenderly's Action SDK threads this
    // back into the alerting pipeline; the `destination` list in the
    // matching alert preset determines where the message lands
    // (slack-crosschain per alerts-crosschain.yaml §F).
    const summary =
      `🚨 VpfiBuyReceiver stuck-VPFI cluster on Base: ${events.length} ` +
      `events in last 1h (threshold ${threshold}). ` +
      `Inspect upstream adapter chains for systemic delivery failures.`;
    const sample = events.slice(0, 5).map((e) => {
      // ethers v6 EventLog carries decoded args; fall back to raw if not.
      const args = (e as { args?: { messageId?: bigint; buyer?: string; vpfiAmount?: bigint; reason?: string } }).args;
      return {
        block: e.blockNumber,
        tx: e.transactionHash,
        messageId: args?.messageId?.toString(),
        buyer: args?.buyer,
        vpfiAmount: args?.vpfiAmount?.toString(),
        reason: args?.reason,
      };
    });
    console.warn(summary, { sample });
    // Tenderly Actions surface console.warn into the alert destination
    // configured for the preset; no separate emit step needed.
  }
};
