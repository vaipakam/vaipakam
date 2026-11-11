/**
 * The suite's chain as a scenario (`@vaipakam/anvil-harness`): the node
 * global setup spawned, the fixture it deployed, and this run's ephemeral
 * role wallets acting as the scenario's lender and borrower, so a spec can
 * open, repay and pause through the protocol's public entry points as the
 * same wallets the app is connected with.
 */
import fs from 'node:fs';
import type { Hex } from 'viem';
import { anvilControl } from '@vaipakam/anvil-harness/rpc';
import { txValidUntil } from '@vaipakam/lib/txDeadline';
import { ScenarioChain, type ChainFixture } from '@vaipakam/anvil-harness/scenarioChain';
import { ANVIL_URL } from './anvil';
import { FIXTURE_FILE } from './artifacts';
import { CHAIN_ID } from './wallet';
import { accountFor, type Role } from './wallets';

/** The scenario chain, with the harness's lender and borrower played by the
 *  suite's `lender` and `borrower` wallets unless `cast` names other roles
 *  (a spec that needs wallets with no history casts the fresh ones). */
export function scenario(cast: { lender?: Role; borrower?: Role } = {}): ScenarioChain {
  const saved = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')) as { diamond: Hex; adminKey: Hex; artifact: Record<string, unknown> };
  const fixture: ChainFixture = {
    diamond: saved.diamond,
    adminKey: saved.adminKey,
    artifact: saved.artifact,
    // Read only by the reward-day helpers, which this suite does not drive.
    rewards: { interactionLaunchTimestamp: 0 },
  };
  return new ScenarioChain({ url: ANVIL_URL, control: anvilControl(ANVIL_URL) }, fixture, CHAIN_ID, {
    name: 'alpha05-e2e',
    accounts: { lender: accountFor(cast.lender ?? 'lender'), borrower: accountFor(cast.borrower ?? 'borrower') },
  });
}

/** #3412 — the `validUntil` a price-exposed write carries (posting or
 *  changing an offer or a standing intent, a sale, a swap-to-repay, an
 *  offset, a handover): the shared thirty-minute window
 *  (`@vaipakam/lib/txDeadline`) measured from the chain's latest block,
 *  never the host clock, since the suite moves the chain's time on its own.
 *  Read it right before the write it goes into. */
export async function txDeadline(sc: ScenarioChain): Promise<bigint> {
  const block = await sc.pub.getBlock({ blockTag: 'latest' });
  return txValidUntil(block.timestamp);
}
