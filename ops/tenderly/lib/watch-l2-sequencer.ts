import { ActionFn, Context, PeriodicEvent } from '@tenderly/actions';
import { ethers } from 'ethers';

/**
 * Scheduled action: fire on state transitions of the L2 sequencer uptime
 * feed (up → down or down → up). The Chainlink L2 Sequencer Uptime Feed
 * returns 0 when up, 1 when down, with `startedAt` marking the transition.
 * DefaultedFacet refuses default processing during the 1h grace window
 * after recovery — we need to track both the outage and the grace window
 * close so the oncall can resume default processing promptly.
 */
const UPTIME_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

export const watchL2Sequencer: ActionFn = async (context: Context, _event: PeriodicEvent) => {
  const feed = await context.secrets.get('SEQUENCER_UPTIME_FEED');
  const rpcUrl = await context.secrets.get('RPC_URL');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(feed, UPTIME_ABI, provider);

  const { answer, startedAt } = await contract.latestRoundData();
  const isDown = BigInt(answer) === 1n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const ageSinceTransition = now - BigInt(startedAt);
  const inGrace = !isDown && ageSinceTransition < 3600n;

  const prev = await context.storage.getStr('sequencer_state');
  const current = isDown ? 'down' : inGrace ? 'grace' : 'up';

  if (prev !== current) {
    await context.storage.putStr('sequencer_state', current);
    if (current !== 'up') {
      throw new Error(
        `L2 sequencer transitioned to ${current} (age since transition: ${ageSinceTransition}s)`,
      );
    }
  }
};
