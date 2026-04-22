import { ActionFn, Context, PeriodicEvent } from '@tenderly/actions';
import { ethers } from 'ethers';

/**
 * Scheduled action: for every Chainlink feed registered via
 * OracleAdminFacet.setPriceFeed, alert when the feed's age exceeds
 * `warn_ratio_bps` of its heartbeat. This is a lead-time warning vs.
 * the OracleFacet.StalePriceData revert — StalePriceData is the hard
 * block, this is the "we're 80% of the way to a block" signal.
 *
 * The feed list is maintained in `tenderly/lib/feed-registry.json` —
 * bump that file when a new asset is onboarded via OracleAdminFacet.
 */
const FEED_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

interface FeedEntry {
  asset: string;
  feed: string;
  heartbeatSeconds: number;
  symbol: string;
}

export const watchFeedHeartbeat: ActionFn = async (context: Context, _event: PeriodicEvent) => {
  const rpcUrl = await context.secrets.get('RPC_URL');
  const warnRatioBps = Number((await context.storage.getStr('warn_ratio_bps')) || '8000');
  const registryJson = await context.storage.getStr('feed_registry');
  const registry: FeedEntry[] = registryJson ? JSON.parse(registryJson) : [];

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const now = Math.floor(Date.now() / 1000);
  const drifting: { symbol: string; ageSec: number; heartbeat: number }[] = [];

  for (const entry of registry) {
    try {
      const feed = new ethers.Contract(entry.feed, FEED_ABI, provider);
      const { updatedAt } = await feed.latestRoundData();
      const ageSec = now - Number(updatedAt);
      if (ageSec * 10000 > entry.heartbeatSeconds * warnRatioBps) {
        drifting.push({ symbol: entry.symbol, ageSec, heartbeat: entry.heartbeatSeconds });
      }
    } catch (e) {
      console.error(`[watch-feed-heartbeat] ${entry.symbol} feed read failed`, e);
    }
  }

  if (drifting.length > 0) {
    throw new Error(`Feed heartbeat drift: ${JSON.stringify(drifting)}`);
  }
};
