/**
 * #3763 rule 7 — whether the platform's keeper runs a step on this network.
 *
 * A choice that needs a runner (re-lending a repayment today, renewing a loan
 * once renewal is built) happens only when someone submits the step. The
 * platform's keeper does that where its pass for the step is armed. The keeper
 * publishes which of its steps are armed per chain, and the indexer serves
 * them on `GET /keeper/steps?chainId=` (shared table `keeper_step_status`,
 * #3681). This module reads that answer and reduces it to three states:
 *
 * - `running`: the step is armed, said so recently, for the Diamond this app
 *   serves;
 * - `not-running`: the keeper said it is not armed, said nothing for a while,
 *   serves another Diamond, or never published the step on this chain (the
 *   indexer's own reading of a missing row);
 * - `unknown`: the answer could not be read (no indexer, an outage, a shape
 *   the app does not know).
 *
 * The form pre-selects a choice only where its step is `running`.
 */
import type { IndexerClient } from '../reads/world/indexerClient';

type Hex = `0x${string}`;

export type RunnerState = 'running' | 'not-running' | 'unknown';

/** One step as the indexer serves it. */
export interface KeeperStepRow {
  pass: string;
  step: string;
  diamond: string;
  running: boolean;
}

/** A keeper step by its published names. */
export interface StepName {
  pass: string;
  step: string;
}

/**
 * The roll step that re-lends a slot's repayment: the matcher pass's `roll`
 * step. The keeper arms it only where the matcher is armed and it can value
 * the chain's transaction fee. The row says nothing about a wallet's roll
 * permission or the platform token, which the app checks itself.
 */
export const ROLL_STEP: StepName = { pass: 'matcher', step: 'roll' };

/** The auto-extension of a loan at its due date. Armed only where the
 *  keeper's pass is armed AND the network's auto-extend switch reads on; the
 *  row says nothing about either party's consent or funding, which the app
 *  shows per loan. */
export const EXTEND_STEP: StepName = { pass: 'autoLifecycle', step: 'extend' };

/** Parse the route's answer; `null` for a shape the app does not know. */
export function parseKeeperSteps(body: unknown, chainId: number): KeeperStepRow[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { chainId?: unknown; steps?: unknown };
  if (b.chainId !== chainId || !Array.isArray(b.steps)) return null;
  const out: KeeperStepRow[] = [];
  for (const r of b.steps as unknown[]) {
    if (typeof r !== 'object' || r === null) return null;
    const s = r as Record<string, unknown>;
    if (typeof s.pass !== 'string' || typeof s.step !== 'string' || typeof s.diamond !== 'string' || typeof s.running !== 'boolean') return null;
    out.push({ pass: s.pass, step: s.step, diamond: s.diamond, running: s.running });
  }
  return out;
}

/** The state of one step for the Diamond this app serves. `rows === null`
 *  means the answer could not be read. */
export function runnerState(rows: readonly KeeperStepRow[] | null, name: StepName, diamond: Hex): RunnerState {
  if (rows === null) return 'unknown';
  const row = rows.find((r) => r.pass === name.pass && r.step === name.step);
  if (!row) return 'not-running';
  if (row.diamond.toLowerCase() !== diamond.toLowerCase()) return 'not-running';
  return row.running ? 'running' : 'not-running';
}

/** Read the published steps for one chain; `null` when they cannot be read. */
export async function readKeeperSteps(indexer: IndexerClient, chainId: number): Promise<KeeperStepRow[] | null> {
  try {
    return parseKeeperSteps(await indexer.getJson<unknown>(`/keeper/steps?chainId=${chainId}`), chainId);
  } catch {
    return null;
  }
}
