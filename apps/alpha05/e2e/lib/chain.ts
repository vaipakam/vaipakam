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
import { ScenarioChain, type ChainFixture } from '@vaipakam/anvil-harness/scenarioChain';
import { ANVIL_URL } from './anvil';
import { FIXTURE_FILE } from './artifacts';
import { CHAIN_ID } from './wallet';
import { accountFor } from './wallets';

export function scenario(): ScenarioChain {
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
    accounts: { lender: accountFor('lender'), borrower: accountFor('borrower') },
  });
}
