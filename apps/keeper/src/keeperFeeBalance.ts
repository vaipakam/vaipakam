// apps/keeper/src/keeperFeeBalance.ts
//
// #3365 — the KEEPER FEE BALANCE alert: tells the ops chat when the keeper
// wallet's native balance on a chain would not pay for the liquidations the
// keeper may have to send there, so the liquidation backstop cannot quietly
// run dry in a crash.
//
// Each run (every tick), per chain with a Diamond:
//
//   1. Read the keeper wallet's native balance and the fee a keeper send is
//      prepared at right now: `estimateFeesPerGas`, the same estimate viem's
//      send path uses (the wallet carries no chain object, so both take the
//      EIP-1559 maxFeePerGas where the chain's blocks carry a base fee, and
//      the legacy gas price otherwise). A node refuses a transaction whose
//      sender cannot cover gas limit x that fee, so this is the figure that
//      decides whether a liquidation can be sent at all.
//   2. The reserve is RESERVE_LIQUIDATIONS sends of LIQUIDATION_GAS each at
//      that fee. Both are knobs (KEEPER_FEE_RESERVE_LIQUIDATIONS,
//      KEEPER_FEE_RESERVE_LIQUIDATION_GAS); the defaults are stated below.
//      What the reserve does NOT count is stated in the alert: the L1 data
//      fee an OP-stack chain adds on top of execution gas.
//   3. Below the reserve: a LOW alert. Below one liquidation's cost: a
//      CRITICAL alert, under its own key so an escalation alerts at once
//      rather than waiting out the low alert's re-send interval. Each re-sends
//      every ALERT_INTERVAL_SEC while it holds.
//   4. Back above RECOVERY_PCT of the reserve with an alert open: one
//      recovery message, then the records are cleared so the next shortfall
//      alerts at once. The margin keeps a balance sitting on the line (the
//      fee moves every block) from alternating low and recovered each tick.
//
// A read that fails is reported in the run line and changes no alert state:
// an unknown balance is neither low nor recovered.
//
// The alert is about the keeper's own wallet, not about a Diamond's state, so
// it is posted unfenced (no chain id to `sendOpsAlert`): an indexer epoch
// change must not hide a wallet running dry.
//
// Read-only: it sends no transaction. Gated by KEEPER_ENABLED +
// KEEPER_FEE_BALANCE_ALERT_ENABLED (a disarmed keeper sends no liquidation, so
// it needs no reserve). Ships disarmed.

import { createPublicClient, formatEther, formatGwei, http, type Address, type PublicClient } from 'viem';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { passIsArmed, resolveKeeperAccount } from './keeper';
import type { PassTick } from './passSchedule';
import { sendOpsAlert, type OpsAlertOutcome } from './opsAlert';
import { clearOpsAlert, getOpsAlert } from './db';
import { txFeeModel } from './txFee';
import { shortErr } from './callErrors';
import { deadlineClient } from './batchRead';

/** Liquidations the reserve covers by default: the liquidator sends at most
 *  12 a chain a tick (`MAX_LIQUIDATIONS_PER_TICK`), so 20 is a busy tick and
 *  most of the next. */
export const DEFAULT_RESERVE_LIQUIDATIONS = 20;
/** Gas limit assumed per liquidation by default. A deliberate overestimate: a
 *  liquidation sells collateral through a swap adapter (and may fall back to
 *  custody), and the keeper's limit is its estimate plus 30%
 *  (`gasLimitFromEstimate`). Lower it once real liquidations are measured. */
export const DEFAULT_LIQUIDATION_GAS = 2_500_000n;
/** An open alert recovers only above this share of the reserve. */
export const RECOVERY_PCT = 120n;
/** How often an alert that still holds is re-sent. */
export const ALERT_INTERVAL_SEC = 6 * 3600;

export type FeeLevel = 'ok' | 'low' | 'critical';

export const lowKey = (chainId: number): string => `keeper-fee-low:${chainId}`;
export const criticalKey = (chainId: number): string => `keeper-fee-critical:${chainId}`;
export const recoveredKey = (chainId: number): string => `keeper-fee-recovered:${chainId}`;

/** A knob's value: the parsed figure, and, when it was not usable, why the
 *  default was taken instead. */
export interface Knob<T> {
  value: T;
  /** Set when the variable was set but malformed. */
  malformed?: string;
}

function positiveInteger(raw: string | undefined, name: string, fallback: bigint): Knob<bigint> {
  const text = (raw ?? '').trim();
  if (text === '') return { value: fallback };
  if (!/^\d+$/.test(text) || BigInt(text) === 0n) {
    return { value: fallback, malformed: `${name} is not a positive whole number, so the default ${fallback} is used` };
  }
  return { value: BigInt(text) };
}

/** The reserve's two figures, from the environment. A malformed knob never
 *  turns the alert off: the default is used and the alert says so. */
export function reserveSettings(env: Pick<Env, 'KEEPER_FEE_RESERVE_LIQUIDATIONS' | 'KEEPER_FEE_RESERVE_LIQUIDATION_GAS'>): {
  liquidations: Knob<bigint>;
  gas: Knob<bigint>;
} {
  return {
    liquidations: positiveInteger(env.KEEPER_FEE_RESERVE_LIQUIDATIONS, 'KEEPER_FEE_RESERVE_LIQUIDATIONS', BigInt(DEFAULT_RESERVE_LIQUIDATIONS)),
    gas: positiveInteger(env.KEEPER_FEE_RESERVE_LIQUIDATION_GAS, 'KEEPER_FEE_RESERVE_LIQUIDATION_GAS', DEFAULT_LIQUIDATION_GAS),
  };
}

/** The chain's native coin, for the message. */
export function nativeSymbol(chainId: number): string {
  if (chainId === 56 || chainId === 97) return 'BNB';
  if (chainId === 137) return 'POL';
  return 'ETH';
}

/** What one chain's reading came to. Pure. */
export interface FeeReading {
  balanceWei: bigint;
  feePerGasWei: bigint;
  /** Cost of one liquidation at the current fee. */
  perLiquidationWei: bigint;
  reserveWei: bigint;
  level: FeeLevel;
  /** Above the recovery margin: an open alert may close. */
  recovered: boolean;
}

export function assess(balanceWei: bigint, feePerGasWei: bigint, liquidations: bigint, gas: bigint): FeeReading {
  const perLiquidationWei = gas * feePerGasWei;
  const reserveWei = perLiquidationWei * liquidations;
  const level: FeeLevel = balanceWei < perLiquidationWei ? 'critical' : balanceWei < reserveWei ? 'low' : 'ok';
  return {
    balanceWei,
    feePerGasWei,
    perLiquidationWei,
    reserveWei,
    level,
    recovered: balanceWei * 100n >= reserveWei * RECOVERY_PCT,
  };
}

/** How many liquidations the balance pays for at the current fee. */
function affordable(r: FeeReading): bigint {
  return r.perLiquidationWei === 0n ? 0n : r.balanceWei / r.perLiquidationWei;
}

function assumptions(chainId: number, liquidations: Knob<bigint>, gas: Knob<bigint>, r: FeeReading): string {
  const sym = nativeSymbol(chainId);
  const lines = [
    `Reserve assumed: ${liquidations.value} liquidations of ${gas.value} gas each at the current fee of ${formatGwei(r.feePerGasWei)} gwei = ${formatEther(r.reserveWei)} ${sym}.`,
  ];
  if (txFeeModel(chainId) === 'opStack') lines.push('Not counted: the L1 data fee and the operator fee this OP-stack chain adds to each transaction.');
  for (const k of [liquidations, gas]) if (k.malformed) lines.push(`Setting problem: ${k.malformed}.`);
  return lines.join('\n');
}

export function alertText(chain: Pick<ChainConfig, 'id' | 'name'>, wallet: Address, liquidations: Knob<bigint>, gas: Knob<bigint>, r: FeeReading): string {
  const sym = nativeSymbol(chain.id);
  const head =
    r.level === 'critical'
      ? `CRITICAL: the keeper wallet on ${chain.name} (${chain.id}) cannot pay for even one liquidation.`
      : `The keeper wallet on ${chain.name} (${chain.id}) is low on ${sym} for liquidation fees.`;
  return [
    head,
    `Wallet ${wallet} holds ${formatEther(r.balanceWei)} ${sym}, enough for ${affordable(r)} liquidation(s) at today's fee (one costs about ${formatEther(r.perLiquidationWei)} ${sym}).`,
    assumptions(chain.id, liquidations, gas, r),
    `Top it up with ${sym} on ${chain.name}. Until then the keeper may be unable to liquidate unhealthy loans there.`,
  ].join('\n');
}

export function recoveryText(chain: Pick<ChainConfig, 'id' | 'name'>, wallet: Address, liquidations: Knob<bigint>, gas: Knob<bigint>, r: FeeReading): string {
  const sym = nativeSymbol(chain.id);
  return [
    `Recovered: the keeper wallet on ${chain.name} (${chain.id}) can pay for liquidations again.`,
    `Wallet ${wallet} holds ${formatEther(r.balanceWei)} ${sym}, enough for ${affordable(r)} liquidation(s) at today's fee.`,
    assumptions(chain.id, liquidations, gas, r),
  ].join('\n');
}

/** What the run reads and writes, injected so it is testable. */
export interface FeeBalanceDeps {
  readBalance: (chain: ChainConfig, wallet: Address) => Promise<bigint>;
  readFeePerGas: (chain: ChainConfig) => Promise<bigint>;
  send: (env: Env, key: string, text: string, intervalSec: number) => Promise<OpsAlertOutcome>;
  prior: (env: Env, key: string) => Promise<unknown>;
  clear: (env: Env, key: string) => Promise<void>;
}

/** One chain's outcome, for the run line. */
export type ChainOutcome =
  | { kind: 'unread'; reason: string }
  | { kind: 'ok'; reading: FeeReading }
  | { kind: 'alerted'; reading: FeeReading; outcome: OpsAlertOutcome }
  | { kind: 'holding'; reading: FeeReading }
  | { kind: 'recovered'; reading: FeeReading; outcome: OpsAlertOutcome };

/** The fee per gas viem prepares a send at. Like `prepareTransactionRequest`,
 *  the fee model follows the latest block: a block with a base fee is priced
 *  EIP-1559 (maxFeePerGas), one without is priced legacy (gasPrice). Asking
 *  for EIP-1559 fees on a legacy-only chain throws instead of falling back. */
export async function viemFeePerGas(client: Pick<PublicClient, 'getBlock' | 'estimateFeesPerGas'>): Promise<bigint> {
  const block = await client.getBlock();
  if (typeof block.baseFeePerGas === 'bigint') {
    return (await client.estimateFeesPerGas({ type: 'eip1559', chain: null })).maxFeePerGas;
  }
  return (await client.estimateFeesPerGas({ type: 'legacy', chain: null })).gasPrice;
}

export async function checkChain(env: Env, chain: ChainConfig, wallet: Address, deps: FeeBalanceDeps): Promise<ChainOutcome> {
  const { liquidations, gas } = reserveSettings(env);
  let reading: FeeReading;
  try {
    const [balance, fee] = await Promise.all([deps.readBalance(chain, wallet), deps.readFeePerGas(chain)]);
    reading = assess(balance, fee, liquidations.value, gas.value);
  } catch (err) {
    return { kind: 'unread', reason: shortErr(err) };
  }

  if (reading.level !== 'ok') {
    const key = reading.level === 'critical' ? criticalKey(chain.id) : lowKey(chain.id);
    const outcome = await deps.send(env, key, alertText(chain, wallet, liquidations, gas, reading), ALERT_INTERVAL_SEC);
    // Leaving critical for low clears the critical record, so a fall back
    // below one liquidation alerts at once, but only once a low record stands
    // (just sent, or sent recently enough to be suppressed). Until then the
    // critical record is the only sign an alert is open, and the recovery
    // message depends on it.
    if (reading.level === 'low' && (outcome === 'sent' || outcome === 'suppressed')) await deps.clear(env, criticalKey(chain.id));
    return { kind: 'alerted', reading, outcome };
  }

  const open = (await deps.prior(env, lowKey(chain.id))) !== null || (await deps.prior(env, criticalKey(chain.id))) !== null;
  if (!open) return { kind: 'ok', reading };
  if (!reading.recovered) return { kind: 'holding', reading };
  const outcome = await deps.send(env, recoveredKey(chain.id), recoveryText(chain, wallet, liquidations, gas, reading), 0);
  // A recovery that did not reach Telegram (a failed post, or the epoch
  // fence) keeps the alert open and is tried again next run; an unconfigured
  // ops channel already logged the text, so retrying would only repeat it.
  if (outcome === 'sent' || outcome === 'unconfigured') {
    for (const key of [lowKey(chain.id), criticalKey(chain.id), recoveredKey(chain.id)]) await deps.clear(env, key);
  }
  return { kind: 'recovered', reading, outcome };
}

export function describeOutcome(chain: Pick<ChainConfig, 'id'>, o: ChainOutcome): string {
  const prefix = `[keeper] keeperFeeBalance chain=${chain.id}`;
  if (o.kind === 'unread') return `${prefix}: balance or fee unread (${o.reason}); alert state unchanged`;
  const r = o.reading;
  const figures = `balance=${formatEther(r.balanceWei)} reserve=${formatEther(r.reserveWei)} perLiquidation=${formatEther(r.perLiquidationWei)} feePerGas=${formatGwei(r.feePerGasWei)}gwei level=${r.level}`;
  switch (o.kind) {
    case 'ok':
      return `${prefix}: ${figures}`;
    case 'alerted':
      return `${prefix}: ${figures} alert=${o.outcome}`;
    case 'holding':
      return `${prefix}: ${figures} alert open, below the ${RECOVERY_PCT}% recovery margin`;
    case 'recovered':
      return `${prefix}: ${figures} recovery=${o.outcome}`;
  }
}

const DEFAULT_DEPS: Omit<FeeBalanceDeps, 'readBalance' | 'readFeePerGas'> = {
  send: (env, key, text, interval) => sendOpsAlert(env, key, text, interval),
  prior: (env, key) => getOpsAlert(env.KEEPER_DB, key),
  clear: (env, key) => clearOpsAlert(env.KEEPER_DB, key),
};

export async function runKeeperFeeBalance(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'keeperFeeBalance', 'KEEPER_FEE_BALANCE_ALERT_ENABLED')) return;
  // passIsArmed has already refused an unusable key; this only narrows it.
  const resolved = resolveKeeperAccount(env.KEEPER_PRIVATE_KEY ?? '');
  if (!('account' in resolved)) return;
  const wallet = resolved.account.address;
  const clients = new Map<number, PublicClient>();
  const clientFor = (chain: ChainConfig): PublicClient => {
    let c = clients.get(chain.id);
    if (!c) {
      c = deadlineClient(createPublicClient({ transport: http(chain.rpc) }) as PublicClient, tick.deadlineMs);
      clients.set(chain.id, c);
    }
    return c;
  };
  const deps: FeeBalanceDeps = {
    ...DEFAULT_DEPS,
    readBalance: (chain, address) => clientFor(chain).getBalance({ address }),
    readFeePerGas: (chain) => viemFeePerGas(clientFor(chain)),
  };
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  await Promise.all(
    chains.map(async (chain) => {
      try {
        console.log(describeOutcome(chain, await checkChain(env, chain, wallet, deps)));
      } catch (err) {
        console.error(`[keeper] keeperFeeBalance chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}
