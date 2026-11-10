// apps/keeper/src/protectedAccount.ts
//
// #3088 / #2984 — the PROTECTED ACCOUNT pass: the permissionless steps of
// protected account mode that nothing else calls on a schedule. Each one is
// open to anyone; without a keeper it waits until the owner, a signer or
// someone else makes the call by hand.
//
// Per chain, per run (every minute): the two Telegram steps when armed
// (`protectedTelegram.ts`: owner alerts, then LOCK), then the steps below, in
// an order rotated one place a run (`stepOrder`):
//
//   1. RELEASE — pay each queued payout whose delay has passed
//      (`VaultPayoutFacet.releasePayout`) and move each queued position-NFT
//      transfer whose delay has passed (`VaipakamNFTFacet.
//      releasePositionTransfer`). A row is sent only when the chain's own
//      record says it can go: still queued, past its release time by the
//      block's clock, its account not locked and with no open Telegram LOCK
//      request, and, while the account requires a co-sign, co-signed. A payout whose destination has left the account's
//      allowlist is cancelled by the release itself (the asset stays in the
//      vault); the run names it apart from a paid one. A recipient the
//      sanctions screen flags makes the release revert and the row stays
//      queued: the run names the refusal and tries again next run.
//   2. FINALIZE — apply each pending change whose delay has passed. Since
//      #3379 Stage B2 the account's protected record is held by its vault
//      (`protectedVault.ts`), so these go to the vault's own permissionless
//      finalizers through `vault.protect(...)`: the vault's setting changes
//      (`finalizeSettings`: a lowered delay, an unlock, switching the mode
//      off — which waits while the account has open rows, and is counted
//      waiting when the chain says so), an allowlist addition that has not
//      expired (`finalizeAllowlisted`), a signer addition the nominee has
//      accepted and that has not expired, or a signer removal
//      (`finalizeSigner`; each addition expires one delay after it matures,
//      as the chain refuses it then), and a scheduled replacement of the
//      primary wallet (`finalizeReplacement`). The co-sign requirement's
//      switch-off stays on the Diamond (`finalizeSettingChanges`). A
//      finalize that changes the account's posture (an unlock, a switch-off,
//      a replacement) is followed by the Diamond's `applyProtection`, which
//      applies the platform side of it. Nothing that is not due is sent, and
//      nothing is sent for a locked account except what an unlock itself
//      needs.
//
//      B2 limits, stated: the vault exposes no view of its pending setting
//      times, so a vault setting change (kinds 1, 2, 5) is read as unread
//      and never sent; and the replacement's approval tally is not readable,
//      so the vault's own check at the simulation decides it. And the
//      vault, not the Diamond, now emits the `*Requested` / `Scheduled`
//      events below, which the indexer's ledger does not carry: until it
//      does (B4), only the Diamond's co-sign switch-off is nominated.
//
// The work is nominated by the indexer's event ledger: `PayoutQueued` and
// `PositionTransferQueued` for step 1, the `*Requested` / `Scheduled` events
// for step 2. Each step reads its own page a run, from where the last run
// stopped and wrapping round, above a floor every row before which is
// finished (`ledgerRotation.ts`). A row is finished only when the chain shows
// it so at the finalized block: a payout or transfer no longer queued, a
// change whose pending time no longer equals the one its event announced
// (applied, cancelled or replaced by a newer request). Every decision is the
// chain's own record against the chain's own clock; a row only nominates.
// A page's records and the settings of the accounts its events name are read
// in one batch, so the settings never wait behind the records; and each run
// tries the page from a different row (`ledgerRotation.attemptOrder`), so a
// run of slow refusals at its top cannot keep a row below them unsent.
//
// Every call is simulated on the current state first and waits for its
// receipt before the next (`stepSender.ts`). None carries value from the
// keeper, and none moves value to it: a release pays the account's own
// recipient from the account's own vault. Needs no on-chain role.
//
// Gated by KEEPER_ENABLED + PROTECTED_ACCOUNT_ENABLED. Ships disarmed.

import { createPublicClient, decodeEventLog, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import {
  ProtectedAccountFacetABI,
  VaipakamDiamondABI,
  VaipakamNFTFacetABI,
  VaipakamVaultImplementationABI,
  VaultDepositoryFacetABI,
  VaultPayoutFacetABI,
  VaultProtectionABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, subStepArmed, type KeeperContext } from './keeper';
import { AlertDelivery, type Alert, type DeliveryOutcome } from './alertDelivery';
import { alertOwners, d1ProtectedStore, LOCK_REQUEST_TTL_SEC, lockFromTelegram, type AlertReport, type LockResult, type ProtectedStore } from './protectedTelegram';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline } from './batchRead';
import { shortErr } from './callErrors';
import { d1EventLedger, type EventLedger, type LedgerRow } from './eventLedger';
import { attemptOrder, readLedgerRotation, type LedgerRotation } from './ledgerRotation';
import { d1ScanCursors, type FinalBlock, type ScanCursors } from './scanCursors';
import { boundedCall, PassReader, type ReadCall } from './passReader';
import { StepSender } from './stepSender';
import { leadStageCutoffMs, runIndex } from './runWindow';
import { LEGACY_DIAMOND_NFT_ABI, positionNftForDiamond } from './positionNft';
import { protectionCall } from '@vaipakam/lib/protectedAccountView';
import type { DiamondProtection, VaultProtectionState } from '@vaipakam/lib/protectedAccountView';
import { accountFrom, noVault, protectionRead, vaultReads, type ProtectedAccount } from './protectedVault';

/** Only the functions and events this pass names, plus every Diamond error. */
const PICK: ReadonlySet<string> = new Set([
  'releasePayout',
  'lockVaultFor',
  'requestCode',
  'getPendingPayout',
  'getPendingPositionTransfer',
  'releasePositionTransfer',
  // #3379 B2: the Diamond names the account's vault and keeps the co-sign
  // setting; the vault holds the rest of the record and its finalizers.
  'getProtection',
  'applyProtection',
  'finalizeSettingChanges',
  'protect',
  'protectionState',
  'vaultOwner',
  'allowEntry',
  'signerEntry',
  'replacementProposal',
  'pendingAdditions',
  'PayoutReleased',
  'PayoutCancelled',
  // What applying each change emits ({@link changeApplied}): the Diamond's
  // for the co-sign switch-off, the vault's for the rest.
  'SettingChangeApplied',
  'ProtectionSettingApplied',
  'ProtectionDisabled',
  'AllowlistAdded',
  'SignerAdded',
  'SignerRemoved',
  'PrimaryReplaced',
]);
const pick = (abi: unknown) => (abi as Abi).filter((x) => x.type === 'error' || ('name' in x && PICK.has(x.name)));
export const ABI = dedupe([
  ...pick(VaultPayoutFacetABI),
  ...pick(VaipakamNFTFacetABI),
  // #3205: the position-NFT queue reads and release exist only on a
  // legacy-mode Diamond, named in the frozen fragment.
  // TODO(#3321 positionNft-legacy-removal): drop with the legacy mode.
  ...pick(LEGACY_DIAMOND_NFT_ABI),
  ...pick(ProtectedAccountFacetABI),
  ...pick(VaultDepositoryFacetABI),
  ...pick(VaipakamVaultImplementationABI),
  // The vault's protected-mode rules: their errors (a `protect` call reverts
  // with them) and the events applying a change emits.
  ...pick(VaultProtectionABI),
  ...(VaipakamDiamondABI as Abi).filter((x) => x.type === 'error'),
]);

function dedupe(abi: Abi): Abi {
  const seen = new Set<string>();
  return abi.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }) as Abi;
}

/** The pass's cadence, in seconds; the scheduler reads it from here. A
 *  release is due to the second its delay ends, so a run every minute keeps
 *  the wait the owner chose from growing by more than that. */
export const PASS_CADENCE_SEC = 60;
/** Sends per step per chain per run. Each step has its own share, so a
 *  long payout queue cannot leave an unlock, a replacement or a signer
 *  addition (which expires) unsent run after run, and a burst of Telegram
 *  LOCK requests cannot hold back the rest (`StepSender.stepBudgets`).
 *  `apply` is the Diamond's `applyProtection` after a finalize that changed
 *  an account's posture (#3379 B2): its own share, so the finalizes' share
 *  is not spent on it. One not sent (its share used, the run stopped) is not
 *  retried by this pass; anyone may still call it. */
export const STEP_SENDS: Readonly<Record<string, number>> = { lock: 4, release: 4, transfer: 4, finalize: 4, apply: 4 };
/** The three steps, in the order of the run whose index is 0. */
export const STEP_NAMES = ['release', 'transfer', 'finalize'] as const;
export type StepName = (typeof STEP_NAMES)[number];

/**
 * The order the steps run in on run `visit`: rotated one place a run, so
 * each step goes first one run in three. A share of sends (`STEP_SENDS`)
 * bounds how many calls a step makes; it does not bound how long they take,
 * since every send waits for its receipt. On a chain with slow blocks a step
 * that always ran first could use the whole read window run after run and
 * leave the later steps unread. Rotated, every step starts a run with the
 * whole window at least every third run, so a due unlock, replacement or
 * signer addition waits at most two runs behind a payout queue.
 */
export function stepOrder(visit: number): readonly StepName[] {
  const k = ((Math.trunc(visit) % STEP_NAMES.length) + STEP_NAMES.length) % STEP_NAMES.length;
  return [...STEP_NAMES.slice(k), ...STEP_NAMES.slice(0, k)];
}

/** The share of the read window the owner alerts may use. They run first,
 *  so no receipt wait holds them back; the share keeps a slow channel from
 *  using the time the LOCK step and the releases after them need. */
export const ALERT_STAGE_SHARE = 1 / 3;
/** The share of what is left of the read window the LOCK step may start
 *  locks in. It runs before every release, so without a bound a stream of
 *  LOCK requests with slow receipts would take the whole window each run and
 *  no release or finalize would ever run (Codex #3092 r10). A lock started
 *  inside the share may finish past it; the releases keep the rest. */
export const LOCK_STAGE_SHARE = 1 / 2;

/** Sends per chain per run: every step's share, and no more. */
export const MAX_SENDS_PER_RUN = Object.values(STEP_SENDS).reduce((a, b) => a + b, 0);
export const RECEIPT_TIMEOUT_MS = 30_000;
/** Ledger rows read per step per run, rotating above the step's floor. */
export const PAGE = 200;
export const PAYOUT_FLOOR_ITEM = 'payout-floor';
export const PAYOUT_NEXT_ITEM = 'payout-next';
export const TRANSFER_FLOOR_ITEM = 'transfer-floor';
export const TRANSFER_NEXT_ITEM = 'transfer-next';
export const CHANGE_FLOOR_ITEM = 'change-floor';
export const CHANGE_NEXT_ITEM = 'change-next';

/** `LibProtectedAccount.ROW_*`. */
const ROW_QUEUED = 1;
/** A row the chain does not hold reads as state 0 (never queued). */
const ROW_NONE = 0;

/** `ProtectedAccountFacet.CHANGE_*` → the `ProtectedAccount` field that holds
 *  when that change matures. #3379 B2: only the co-sign switch-off (4) is
 *  still the Diamond's; the switch-off (1), a lowered delay (2) and an unlock
 *  (5) are the vault's, whose pending times are not readable (they read 0 in
 *  the record, so `pendingAt` treats them as unread, never as applied). */
export const SETTING_FIELD: Readonly<Record<number, keyof ProtectedAccount>> = {
  1: 'pendingDisableAt',
  2: 'pendingDelayAt',
  3: 'pendingNftOffAt',
  4: 'pendingCosignOffAt',
  5: 'pendingUnlockAt',
  // 6 (unpin) retired by #3204: a pin change waits at the VaultBeacon, and
  // its keeper pass is #3282.
};
/** The setting kinds the vault holds (its pending times are not readable in
 *  B2). */
const VAULT_SETTINGS: ReadonlySet<number> = new Set([1, 2, 5]);
/** The co-sign switch-off, the one setting still the Diamond's. */
const CHANGE_COSIGN_OFF = 4;
const SETTING_NAME: Readonly<Record<number, string>> = {
  1: 'switch-off',
  2: 'lower-delay',
  3: 'nft-protection-off',
  4: 'cosign-off',
  5: 'unlock',
};
/** The switch-off, which waits for the account's open rows. */
const CHANGE_DISABLE = 1;

export const PAYOUT_EVENT = 'PayoutQueued';
export const TRANSFER_EVENT = 'PositionTransferQueued';
export const CHANGE_EVENTS = [
  'SettingChangeRequested',
  'AllowlistAddRequested',
  'SignerAddRequested',
  'SignerRemoveRequested',
  'ReplacementScheduled',
] as const;

/** Refusals that mean another caller got there first. */
export const RACES = new Set(['RowNotQueued', 'ChangeNotRequested', 'NoReplacementProposed', 'NotRequested', 'NoProposal']);
export const PAUSED_REFUSAL = 'EnforcedPause';
/** `finalizeSettingChanges` when the only due change is a switch-off that
 *  waits for open rows: a wait, not a refusal. */
const SWITCH_OFF_WAITS = 'PendingRowsExist';

/** The account's protected record (`protectedVault.ts`). */
export type { ProtectedAccount } from './protectedVault';

interface PendingPayout {
  user: Address;
  kind: number;
  state: number;
  cosigned: boolean;
  releaseAt: bigint;
  asset: Address;
  recipient: Address;
  tokenId: bigint;
  amount: bigint;
  delivered: bigint;
}

interface PendingTransfer {
  from: Address;
  state: number;
  releaseAt: bigint;
  to: Address;
  tokenId: bigint;
}

/** `vault.signerEntry(who)`. */
interface SignerChange {
  addAt: bigint;
  removeAt: bigint;
  epoch: bigint;
  accepted: boolean;
  active: boolean;
}

/** `vault.allowEntry(destination)`. */
interface AllowEntry {
  readyAt: bigint;
  epoch: bigint;
  active: boolean;
  verified: boolean;
}

/** `vault.replacementProposal()`, positional. */
type ReplacementProposal = readonly [nominee: Address, proposedBy: Address, readyAt: bigint, round: number];

/** `vault.pendingAdditions()`, positional: the additions of the current epoch. */
type PendingAdditions = readonly [allowlist: readonly Address[], signers: readonly Address[]];

/** One pending change an event announced, keyed by what its event named. */
export type Change =
  | { t: 'setting'; account: Address; kind: number; at: bigint }
  | { t: 'allow'; account: Address; other: Address; at: bigint }
  | { t: 'signerAdd'; account: Address; other: Address; at: bigint }
  | { t: 'signerRemove'; account: Address; other: Address; at: bigint }
  | { t: 'replace'; account: Address; other: Address; at: bigint };

/** What one chain's run reads and signs with. Injected so a run is testable. */
export interface ProtectedDeps {
  /** Deadline-bound client: single reads and the clock. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  sendDeadline: number;
  cursors: ScanCursors;
  ledger: EventLedger;
  /** Which run this is (`runIndex`), for the rotated batched reads. */
  visit?: number;
  /** The Telegram steps (`protectedTelegram.ts`); each off when its flag is. */
  telegram?: {
    lock: boolean;
    alerts: boolean;
    store: ProtectedStore;
    notify: (alert: Alert) => Promise<DeliveryOutcome>;
    appOrigin: string;
    nowSec?: () => number;
  };
}

/** What a run did on one chain: its log line's figures, and what tests read. */
export interface ProtectedReport {
  chainId: number;
  skipped?: string;
  /** Payout ids paid this run, with what the recipient received. */
  released: { id: bigint; delivered: bigint }[];
  /** Payout ids the release cancelled (destination no longer allowed). */
  cancelled: bigint[];
  /** Position-transfer ids moved this run. */
  transferred: bigint[];
  /** Why the transfer step did not run on this chain, or null (#3205). */
  transferSkipped: string | null;
  /** Changes applied this run, as `kind:account[:other]`. */
  finalized: string[];
  /** Rows not sent this run for a reason the chain states, by reason. */
  waiting: Map<string, number>;
  /** Each LOCK request worked this run, with how it ended and whether its
   *  answer reached the chat; null when the LOCK step is off. */
  locks: LockResult[] | null;
  /** The alert step's figures; null when it is off. */
  alerts: AlertReport | null;
  refused: Map<string, string>;
  unread: Map<string, string>;
  /** Steps that used their whole share of sends this run; what they left
   *  stays queued for the next run. */
  budgetReached: Set<string>;
  stopped: string | null;
}

export async function runProtectedAccount(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'protectedAccount', 'PROTECTED_ACCOUNT_ENABLED')) return;
  const lock = subStepArmed(env, 'protectedAccount', 'Telegram LOCK', 'PROTECTED_LOCK_ENABLED');
  const alertsOn = subStepArmed(env, 'protectedAccount', 'owner alerts', 'PROTECTED_ALERTS_ENABLED');
  const delivery = new AlertDelivery(env);
  const store = d1ProtectedStore(env.DB);
  const appOrigin = env.FRONTEND_ORIGIN ?? '';
  const sendDeadline = tick.deadlineMs;
  const visit = runIndex(tick, PASS_CADENCE_SEC * 1000);
  const ledger = d1EventLedger(env.DB);
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await protectedOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          sendDeadline,
          cursors: d1ScanCursors(env.KEEPER_DB, chain.id, chain.diamond as string, 'protectedAccount'),
          ledger,
          visit,
          telegram: { lock, alerts: alertsOn, store, notify: (a) => delivery.deliver(a), appOrigin },
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] protectedAccount chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
  delivery.disclose('protectedAccount');
}

/** The run's one line for a chain. */
export function describeReport(r: ProtectedReport): string {
  if (r.skipped) return `[keeper] protectedAccount chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const parts = [
    `[keeper] protectedAccount chain=${r.chainId}`,
    `payouts-released=${r.released.map((x) => `${x.id}(delivered ${x.delivered})`).join(',') || 'none'}`,
    ...(r.cancelled.length > 0 ? [`payouts-cancelled-by-release=${r.cancelled.join(',')} (destination no longer allowed; the asset stays in the vault)`] : []),
    r.transferSkipped
      ? `transfers=skipped (${r.transferSkipped})`
      : `transfers-released=${r.transferred.join(',') || 'none'}`,
    `changes-finalized=${r.finalized.join(',') || 'none'}`,
    ...(r.locks === null
      ? []
      : [`telegram-locks=${r.locks.map((l) => `${l.wallet.slice(0, 10)}(${l.outcome}${l.answered === false ? ', answer not delivered' : ''})`).join(',') || 'none'}`]),
    ...(r.alerts === null
      ? []
      : [
          `owner-alerts=sent ${r.alerts.sent}, retrying ${r.alerts.retrying}, undelivered ${r.alerts.undelivered}, stale ${r.alerts.stale}, unsubscribed ${r.alerts.unsubscribed}`,
        ]),
    ...(r.waiting.size > 0 ? [`waiting=${[...r.waiting].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.budgetReached.size > 0 ? [`step-budget-reached=${[...r.budgetReached].join(',')} (the rest waits for the next run)`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

/** One chain's run. Exported for tests. */
export async function protectedOnce(chainId: number, diamond: Address, deps: ProtectedDeps): Promise<ProtectedReport> {
  const sender = new StepSender(
    {
      pass: 'protectedAccount',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      stepBudgets: STEP_SENDS,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: RACES,
      pausedRefusal: PAUSED_REFUSAL,
      unrecorded: new Set([SWITCH_OFF_WAITS]),
      describe: (s) => String(s),
      spends: 'the gas',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  const report: ProtectedReport = {
    chainId,
    released: [],
    cancelled: [],
    transferred: [],
    transferSkipped: null,
    finalized: [],
    waiting: new Map(),
    locks: deps.telegram?.lock === true ? [] : null,
    alerts: deps.telegram?.alerts === true ? { sent: 0, undelivered: 0, retrying: 0, stale: 0, unsubscribed: 0 } : null,
    refused: sender.refused,
    unread: sender.unread,
    budgetReached: sender.budgetReached,
    stopped: null,
  };
  const r = new Reader(deps, diamond);
  try {
    // The RPC must answer for this chain: a deterministic deployment can put
    // a Diamond at the same address on another chain.
    let served: number;
    try {
      served = await r.call('the chain id', (c) => c.getChainId());
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return { ...report, skipped: `the RPC's chain id could not be read (${shortErr(err)})` };
    }
    if (served !== chainId) return { ...report, skipped: `the RPC configured for chain ${chainId} serves chain ${served}` };
    const step = new Step(r, sender, report, deps, chainId);
    // The alerts first: they send nothing on chain, so no receipt wait of
    // any step can use up their time, and a warning about a queued payout is
    // never held behind a lock or a queue of releases. They take only a
    // share of the read window (`ALERT_STAGE_SHARE`), so a slow channel
    // cannot in turn hold back the LOCK step. The LOCK next, before
    // any release: a lock cancels every queued row, so nothing is released
    // this run for an account its owner just asked to lock. And a request
    // the LOCK step could not reach this run (its share of sends used, the
    // read window spent) still holds back that account's releases: an owner's
    // LOCK is never overtaken by the payout it was sent to stop. The LOCK
    // step in turn starts locks only in a share of what is left
    // (`LOCK_STAGE_SHARE`), so a run of LOCK requests cannot hold back every
    // other owner's releases and matured changes run after run.
    const tg = deps.telegram;
    const tgDeps = tg
      ? {
          r,
          sender,
          cursors: deps.cursors,
          store: tg.store,
          ledger: deps.ledger,
          chainId,
          notify: tg.notify,
          canSign: () => deps.context() !== null,
          lockOn: tg.lock === true,
          appOrigin: tg.appOrigin,
          nowSec: tg.nowSec ?? (() => Math.floor(Date.now() / 1000)),
          markLocked: (w: Address) => step.markLocked(w),
          sendDeadline: deps.sendDeadline,
        }
      : null;
    if (tgDeps && tg!.alerts) {
      const stage = r.withCutoff(leadStageCutoffMs(Date.now(), r.cutoff, ALERT_STAGE_SHARE));
      report.alerts = await alertOwners({ ...tgDeps, r: stage }, r.cutoff);
    }
    if (tgDeps && tg!.lock) {
      report.locks = await lockFromTelegram(tgDeps, leadStageCutoffMs(Date.now(), r.cutoff, LOCK_STAGE_SHARE));
      await step.holdForLockRequests(tg!.store, tgDeps.nowSec());
    }
    const work: Record<StepName, () => Promise<void>> = {
      release: () => step.releasePayouts(),
      transfer: () => step.releaseTransfers(),
      finalize: () => step.finalizeChanges(),
    };
    // eslint-disable-next-line no-await-in-loop
    for (const name of stepOrder(deps.visit ?? 0)) await work[name]();
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('run', 'the run deadline passed during its reads');
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

/** The pass's reads, each stopped at the run's read cutoff (`passReader.ts`). */
class Reader extends PassReader {
  constructor(deps: ProtectedDeps, diamond: Address) {
    super(deps, deps.sendDeadline, diamond, ABI, 'protectedAccount');
  }
}

// ─── Ledger rows ────────────────────────────────────────────────────────────

const lower = (a: unknown): Address | null => {
  const s = String(a ?? '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? (s as Address) : null;
};
const uint = (v: unknown): bigint | null => {
  const s = String(v ?? '');
  return /^\d+$/.test(s) ? BigInt(s) : null;
};

/** The row id a `PayoutQueued` / `PositionTransferQueued` row names. */
export const rowId = (row: LedgerRow): bigint | null => uint(row.args.id);

/** The pending change a step-2 row announces; null when it names none. */
export function changeOf(row: LedgerRow): Change | null {
  const account = lower(row.args.account);
  if (account === null) return null;
  switch (row.kind) {
    case 'SettingChangeRequested': {
      const kind = Number(row.args.kind);
      const at = uint(row.args.effectiveAt);
      return SETTING_FIELD[kind] !== undefined && at !== null ? { t: 'setting', account, kind, at } : null;
    }
    case 'AllowlistAddRequested':
    case 'SignerAddRequested':
    case 'SignerRemoveRequested': {
      const other = lower(row.kind === 'AllowlistAddRequested' ? row.args.destination : row.args.signer);
      const at = uint(row.args.effectiveAt);
      if (other === null || at === null) return null;
      const t = row.kind === 'AllowlistAddRequested' ? 'allow' : row.kind === 'SignerAddRequested' ? 'signerAdd' : 'signerRemove';
      return { t, account, other, at };
    }
    case 'ReplacementScheduled': {
      const other = lower(row.args.nominee);
      const at = uint(row.args.readyAt);
      return other !== null && at !== null ? { t: 'replace', account, other, at } : null;
    }
    default:
      return null;
  }
}

export const changeId = (c: Change): string =>
  c.t === 'setting' ? `setting:${c.account}:${c.kind}:${c.at}` : `${c.t}:${c.account}:${c.other}:${c.at}`;

/** How a change reads in the run's line. */
const changeLabel = (c: Change): string =>
  c.t === 'setting' ? `${SETTING_NAME[c.kind]}:${c.account.slice(0, 10)}` : `${c.t}:${c.account.slice(0, 10)}:${c.other.slice(0, 10)}`;

// ─── The steps ──────────────────────────────────────────────────────────────

class Step {
  private now: bigint | null = null;
  /** Accounts read this run, at the head. */
  private readonly accounts = new Map<Address, ProtectedAccount | undefined>();

  constructor(
    private readonly r: Reader,
    private readonly sender: StepSender,
    private readonly report: ProtectedReport,
    private readonly deps: ProtectedDeps,
    private readonly chainId: number,
  ) {}

  /** Wallets with a LOCK request still open; null when they could not be
   *  read, and then nothing is released this run (`holdForLockRequests`). */
  private lockRequested: Set<Address> | null = new Set();

  /**
   * Read the wallets whose LOCK request is still open and young enough to be
   * acted on, and hold their payouts and position transfers until the LOCK
   * step reaches them. When the read fails, hold every release this run: a
   * release cannot be undone, and an owner who sent LOCK sent it to stop one.
   */
  async holdForLockRequests(store: ProtectedStore, nowSec: number): Promise<void> {
    try {
      this.lockRequested = await boundedCall(this.r.cutoff, 'the open LOCK requests', () =>
        store.pendingLockWallets(this.chainId, nowSec - LOCK_REQUEST_TTL_SEC),
      );
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      this.lockRequested = null;
      this.sender.noteUnread('release', `the open LOCK requests (${shortErr(err)}); no payout or transfer is released this run`);
    }
  }

  /** The lock step locked `wallet` this run: read it as locked from here on. */
  markLocked(wallet: Address): void {
    const a = this.accounts.get(wallet);
    this.accounts.set(wallet, { ...(a ?? ({ enabled: true } as ProtectedAccount)), locked: true });
  }

  private wait(why: string): void {
    this.report.waiting.set(why, (this.report.waiting.get(why) ?? 0) + 1);
  }

  /** The chain's clock, read once a run; null (and said) when unread. */
  private async clock(step: string): Promise<bigint | null> {
    if (this.now !== null) return this.now;
    try {
      this.now = (await this.r.call("the chain's clock", (c) => c.getBlock())).timestamp;
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      this.sender.noteUnread(step, `the chain's clock (${shortErr(err)})`);
      return null;
    }
    return this.now;
  }

  /** An account's settings as read this run; undefined until a read of
   *  them has come back. */
  private known(a: Address): boolean {
    return this.accounts.get(a) !== undefined;
  }

  /**
   * Complete the settings of the accounts whose Diamond answer
   * (`getProtection`: which vault) came back, from their vaults (#3379 B2).
   * An answer that did not come back, or a vault read that did not, changes
   * nothing, so a later read this run may still fill it. An account with no
   * vault is known at once: protected mode off.
   */
  private async learn(answers: readonly { account: Address; protection: unknown }[]): Promise<void> {
    const need = new Map<Address, DiamondProtection>();
    for (const { account, protection } of answers) {
      if (protection === undefined || this.known(account) || need.has(account)) continue;
      const p = protection as DiamondProtection;
      if (noVault({ vault: p[0] })) this.accounts.set(account, accountFrom(account, p, null, null));
      else need.set(account, p);
    }
    const want = [...need];
    const got = await this.r.groups(want.map(([, p]) => vaultReads(p[0])), 'vaults');
    want.forEach(([account, p], i) => {
      const [state, owner] = got[i];
      if (state !== undefined && owner !== undefined) {
        this.accounts.set(account, accountFrom(account, p, state as VaultProtectionState, owner as Address));
      }
    });
  }

  /** The accounts' settings at the head, for those not read yet this run. */
  private async readAccounts(accounts: readonly Address[]): Promise<void> {
    const want = [...new Set(accounts)].filter((a) => !this.known(a));
    const got = await this.r.many(want.map(protectionRead), 'accounts');
    await this.learn(want.map((account, i) => ({ account, protection: got[i] })));
  }

  /**
   * `calls`, each read TOGETHER with the Diamond's answer for the account it
   * names (which vault, and the co-sign setting), when its settings are not
   * read yet this run; returns `calls`' answers. A row's account is named by
   * the event that queued it, so its settings need not wait for its record.
   * The rest of the settings is then read from each named vault (#3379 B2:
   * the record lives there, and its address is the Diamond's answer).
   *
   * Each record and its Diamond answer are one group of the reader
   * (`PassReader.groups`), which never splits a group across chunks. A read
   * window that completes only some chunks therefore still yields whole
   * pairs. The Diamond read is repeated for every record of the same
   * account rather than shared: shared, it sits in one chunk, and a record of
   * that account in another chunk can be read every run without its settings
   * ever coming back with it (Codex #3090 r7). The vault's half is read
   * after, once per account; a record whose vault read did not come back has
   * no settings this run and waits, as an unread one always has.
   */
  private async readWithAccounts(calls: readonly AccountCall[], label: string): Promise<unknown[]> {
    const groups = calls.map((c) => {
      const record = { functionName: c.functionName, args: c.args };
      return c.account !== null && !this.known(c.account) ? [record, protectionRead(c.account)] : [record];
    });
    const got = await this.r.groups(groups, label);
    await this.learn(
      calls.flatMap((c, i) => (c.account !== null && got[i].length > 1 ? [{ account: c.account, protection: got[i][1] }] : [])),
    );
    return got.map((g) => g[0]);
  }

  /** The order this run tries the page's nominees in (`attemptOrder`). */
  private order(n: number): number[] {
    return attemptOrder(n, this.deps.visit ?? 0);
  }

  // 1a. Payouts.
  async releasePayouts(): Promise<void> {
    if (this.lockRequested === null) return;
    const page = await readLedgerRotation<bigint>({
      ledger: this.deps.ledger,
      cursors: this.deps.cursors,
      chainId: this.chainId,
      kinds: [PAYOUT_EVENT],
      floorItem: PAYOUT_FLOOR_ITEM,
      nextItem: PAYOUT_NEXT_ITEM,
      limit: PAGE,
      cutoff: this.r.cutoff,
      nominee: rowId,
      id: (id) => String(id),
    });
    if (page === null) {
      this.sender.noteUnread('payout', 'the event ledger of queued payouts');
      return;
    }
    const ids = page.nominees;
    const read = (xs: readonly bigint[], label: string, block?: bigint) =>
      this.r.many(xs.map((id) => ({ functionName: 'getPendingPayout', args: [id] })), label, block);
    const settled = new Set<bigint>();
    if (ids.length > 0) {
      const now = await this.clock('payout');
      if (now === null) return;
      const named = accountsNamed(page);
      const rows = (await this.readWithAccounts(
        ids.map((id) => ({ functionName: 'getPendingPayout', args: [id], account: named.get(id) ?? null })),
        'payouts',
      )) as (PendingPayout | undefined)[];
      // A record naming an account its event did not (none should) has that
      // account read now.
      await this.readAccounts(rows.flatMap((x) => (x && Number(x.state) === ROW_QUEUED ? [lower(x.user)!] : [])));
      for (const i of this.order(ids.length)) {
        const id = ids[i];
        const p = rows[i];
        if (p === undefined) {
          this.sender.noteUnread(`release:${id}`, 'its pending payout record');
          continue;
        }
        if (Number(p.state) !== ROW_QUEUED) {
          // Released or cancelled. A row never queued (state 0) is the
          // ledger ahead of the head the read was made at: not finished.
          if (Number(p.state) !== ROW_NONE) settled.add(id);
          continue;
        }
        if (p.releaseAt > now) {
          this.wait('payout-not-due');
          continue;
        }
        const a = this.accounts.get(lower(p.user)!);
        if (a === undefined) {
          this.sender.noteUnread(`release:${id}`, "its account's settings");
          continue;
        }
        if (a.locked) {
          this.wait('payout-account-locked');
          continue;
        }
        if (this.lockRequested.has(lower(p.user)!)) {
          this.wait('payout-lock-requested');
          continue;
        }
        if (a.requireCosign && !p.cosigned) {
          this.wait('payout-needs-cosign');
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const res = await this.sender.call('release', String(id), 'releasePayout', [id]);
        if (res !== 'landed') continue;
        settled.add(id);
        const receipt = this.sender.receipt;
        const cancelled = receipt?.logs.some((l) => this.isEvent(l, 'PayoutCancelled', id)) ?? false;
        if (cancelled) this.report.cancelled.push(id);
        else this.report.released.push({ id, delivered: this.delivered(receipt, id) });
      }
    }
    // A row is finished once its payout is no longer queued, at the finalized
    // block as at the head (`ledgerRotation.ts`): a release a reorg undoes
    // leaves its row above the floor, to be sent again.
    await page.liftFloor(this.r.finalized, (id) => settled.has(id), async (xs, block: FinalBlock) => {
      const at = (await read(xs, 'payouts-final', block.number)) as (PendingPayout | undefined)[];
      const done = new Set(xs.filter((_, j) => at[j] !== undefined && ![ROW_NONE, ROW_QUEUED].includes(Number(at[j]!.state))));
      return (id) => done.has(id);
    });
  }

  // 1b. Position transfers.
  async releaseTransfers(): Promise<void> {
    // #3205: a chain whose position NFTs live in the standalone PositionNFT
    // has no queued NFT transfer to release; its holder lock's matured
    // unlocks are not executed by this pass.
    if (positionNftForDiamond(this.r.diamond).mode === 'standalone') {
      this.report.transferSkipped =
        'position NFTs live in the standalone PositionNFT: there is no queued transfer, and matured holder unlocks are not sent by this pass';
      return;
    }
    if (this.lockRequested === null) return;
    const page = await readLedgerRotation<bigint>({
      ledger: this.deps.ledger,
      cursors: this.deps.cursors,
      chainId: this.chainId,
      kinds: [TRANSFER_EVENT],
      floorItem: TRANSFER_FLOOR_ITEM,
      nextItem: TRANSFER_NEXT_ITEM,
      limit: PAGE,
      cutoff: this.r.cutoff,
      nominee: rowId,
      id: (id) => String(id),
    });
    if (page === null) {
      this.sender.noteUnread('transfer', 'the event ledger of queued position transfers');
      return;
    }
    const ids = page.nominees;
    const read = (xs: readonly bigint[], label: string, block?: bigint) =>
      this.r.many(xs.map((id) => ({ functionName: 'getPendingPositionTransfer', args: [id] })), label, block);
    const settled = new Set<bigint>();
    if (ids.length > 0) {
      const now = await this.clock('transfer');
      if (now === null) return;
      const named = accountsNamed(page);
      const rows = (await this.readWithAccounts(
        ids.map((id) => ({ functionName: 'getPendingPositionTransfer', args: [id], account: named.get(id) ?? null })),
        'transfers',
      )) as (PendingTransfer | undefined)[];
      // A record naming an account its event did not (none should) has that
      // account read now.
      await this.readAccounts(rows.flatMap((x) => (x && Number(x.state) === ROW_QUEUED ? [lower(x.from)!] : [])));
      for (const i of this.order(ids.length)) {
        const id = ids[i];
        const t = rows[i];
        if (t === undefined) {
          this.sender.noteUnread(`transfer:${id}`, 'its pending position-transfer record');
          continue;
        }
        if (Number(t.state) !== ROW_QUEUED) {
          if (Number(t.state) !== ROW_NONE) settled.add(id);
          continue;
        }
        if (t.releaseAt > now) {
          this.wait('transfer-not-due');
          continue;
        }
        const a = this.accounts.get(lower(t.from)!);
        if (a === undefined) {
          this.sender.noteUnread(`transfer:${id}`, "its account's settings");
          continue;
        }
        if (a.locked) {
          this.wait('transfer-account-locked');
          continue;
        }
        if (this.lockRequested.has(lower(t.from)!)) {
          this.wait('transfer-lock-requested');
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const res = await this.sender.call('transfer', String(id), 'releasePositionTransfer', [id]);
        if (res !== 'landed') continue;
        settled.add(id);
        this.report.transferred.push(id);
      }
    }
    await page.liftFloor(this.r.finalized, (id) => settled.has(id), async (xs, block: FinalBlock) => {
      const at = (await read(xs, 'transfers-final', block.number)) as (PendingTransfer | undefined)[];
      const done = new Set(xs.filter((_, j) => at[j] !== undefined && ![ROW_NONE, ROW_QUEUED].includes(Number(at[j]!.state))));
      return (id) => done.has(id);
    });
  }

  // 2. Pending changes.
  async finalizeChanges(): Promise<void> {
    const page = await readLedgerRotation<Change>({
      ledger: this.deps.ledger,
      cursors: this.deps.cursors,
      chainId: this.chainId,
      kinds: CHANGE_EVENTS,
      floorItem: CHANGE_FLOOR_ITEM,
      nextItem: CHANGE_NEXT_ITEM,
      limit: PAGE,
      cutoff: this.r.cutoff,
      nominee: changeOf,
      id: changeId,
    });
    if (page === null) {
      this.sender.noteUnread('change', 'the event ledger of pending changes');
      return;
    }
    const changes = page.nominees;
    const settled = new Set<string>();
    if (changes.length > 0) {
      const now = await this.clock('change');
      if (now === null) return;
      // #3379 B2: a change's record is held by its account's vault, so the
      // accounts are read first (which vault), then each change's record.
      await this.readAccounts(changes.map((c) => c.account));
      const st = await this.readChanges(changes, (c) => this.accounts.get(c.account));
      // One finalize per account applies every due setting; what it applied
      // is read from its receipt (`applied`), never assumed from its landing
      // (Codex #3090).
      // Keyed by account and by who holds the setting: the co-sign switch-off
      // is the Diamond's call, the rest the vault's (#3379 B2).
      const settingsSent = new Set<string>();
      const applied = new Map<string, readonly ReceiptLog[]>();
      const settingKey = (c: Change) => `${c.t === 'setting' && c.kind === CHANGE_COSIGN_OFF ? 'diamond' : 'vault'}:${c.account}`;
      for (const i of this.order(changes.length)) {
        const c = changes[i];
        const key = changeId(c);
        const s = st[i];
        const a = this.accounts.get(c.account);
        if (s === undefined || a === undefined) {
          this.sender.noteUnread(`finalize:${key}`, 'its pending change or its account');
          continue;
        }
        const pending = pendingAt(c, s);
        if (pending === null) {
          this.sender.noteUnread(`finalize:${key}`, "its pending time, which the account's vault does not expose (#3379 B2)");
          continue;
        }
        if (pending !== c.at) {
          settled.add(key);
          continue;
        }
        if (c.at > now) {
          this.wait('change-not-due');
          continue;
        }
        const why = this.blocked(c, s, a, now);
        if (why !== null) {
          this.wait(why);
          continue;
        }
        let logs: readonly ReceiptLog[];
        if (c.t === 'setting' && settingsSent.has(settingKey(c))) {
          // The account's call this run already went out; it applied this
          // setting only if its receipt says so.
          const sent = applied.get(settingKey(c));
          if (sent === undefined) continue;
          logs = sent;
        } else {
          // eslint-disable-next-line no-await-in-loop
          const res = await this.finalize(c, a);
          if (c.t === 'setting') settingsSent.add(settingKey(c));
          // A due switch-off waits while the account has open rows; the chain
          // refuses the call only when nothing else was due.
          if (res === SWITCH_OFF_WAITS) this.wait('switch-off-waits-for-open-rows');
          if (res !== 'landed') continue;
          logs = this.sender.receipt?.logs ?? [];
          if (c.t === 'setting') applied.set(settingKey(c), logs);
        }
        // A landed call is not proof the change applied: a replacement
        // finalized first drops the account's pending settings, another
        // caller may cancel one between the read and the send, and a
        // switch-off waits while rows are open. Only the change's own event
        // in the receipt reports it; otherwise the next run reads it again.
        if (!changeApplied(logs, this.r.diamond, a.vault, c)) {
          this.wait(c.t === 'setting' && c.kind === CHANGE_DISABLE ? 'switch-off-waits-for-open-rows' : 'change-not-applied');
          continue;
        }
        settled.add(key);
        this.report.finalized.push(changeLabel(c));
        // The platform side of a change of posture (an unlock, a switch-off,
        // a replacement) is applied by the Diamond from the vault's record.
        if (changesPosture(c)) {
          // eslint-disable-next-line no-await-in-loop
          await this.sender.call('apply', c.account, 'applyProtection', [c.account]);
        }
      }
    }
    await page.liftFloor(this.r.finalized, (c) => settled.has(changeId(c)), async (cs, block: FinalBlock) => {
      const at = await this.readChanges(cs, (c) => this.accounts.get(c.account), block.number);
      const done = new Set(
        cs.filter((c, j) => {
          const p = at[j] === undefined ? null : pendingAt(c, at[j]!);
          return p !== null && p !== c.at;
        }).map(changeId),
      );
      return (c) => done.has(changeId(c));
    });
  }

  /** Why a due change is not sent, in the chain's terms; null to send. */
  private blocked(c: Change, s: ChangeState, a: ProtectedAccount, now: bigint): string | null {
    if (!a.enabled) return 'change-mode-off';
    switch (c.t) {
      case 'setting':
        // An unlock is how a locked account gets out; every other setting
        // was dropped by the lock, so a due one here is the unlock's.
        return null;
      case 'allow':
        if (a.locked) return 'change-account-locked';
        // #3379 B2: a replaced account's vault is managed by its new owner,
        // whose additions the vault finalizes like any other (the vault
        // clears the old allowlist at the replacement), so retirement no
        // longer holds one back.
        // Like a signer addition, it expires one delay after it matures.
        if (now > c.at + BigInt(a.delaySeconds)) return 'allowlist-add-expired';
        return null;
      case 'signerAdd': {
        if (a.locked) return 'change-account-locked';
        if (s.t !== 'signer') return null;
        const sc = s.entry;
        if (!sc.accepted) return 'signer-not-accepted';
        // It expires one delay after it matures; only a cancel clears it.
        if (now > sc.addAt + BigInt(a.delaySeconds)) return 'signer-add-expired';
        return null;
      }
      case 'signerRemove':
        return a.locked ? 'change-account-locked' : null;
      case 'replace':
        // A proposal the manager made needs no approvals; any other still
        // needs its majority among the signers active now. #3379 B2: the
        // vault does not expose its tally, so the vault's own check, in the
        // simulation, decides it (`NotReady` when the majority is gone).
        return null;
    }
  }

  /** Send the finalizer of `c`: the Diamond's for the co-sign switch-off,
   *  the account's vault's own (through `protect`) for the rest (#3379 B2). */
  private finalize(c: Change, a: ProtectedAccount): Promise<string> {
    const vault = (fn: string, args: readonly unknown[], subject: string) =>
      this.sender.call('finalize', subject, 'protect', [protectionCall(fn, args)], 0n, undefined, a.vault);
    switch (c.t) {
      case 'setting':
        return c.kind === CHANGE_COSIGN_OFF
          ? this.sender.call('finalize', `settings:${c.account}`, 'finalizeSettingChanges', [c.account])
          : vault('finalizeSettings', [], `settings:${c.account}`);
      case 'allow':
        return vault('finalizeAllowlisted', [c.other], `allow:${c.account}:${c.other}`);
      case 'signerAdd':
        return vault('finalizeSigner', [c.other], `signer-add:${c.account}:${c.other}`);
      case 'signerRemove':
        return vault('finalizeSigner', [c.other], `signer-remove:${c.account}:${c.other}`);
      case 'replace':
        return vault('finalizeReplacement', [], `replace:${c.account}`);
    }
  }

  /** Each change's own pending record, by position; undefined where unread
   *  or where its account (and so its vault) is not known. At the head, or
   *  at `block`. */
  private async readChanges(
    cs: readonly Change[],
    accountOf: (c: Change) => ProtectedAccount | undefined,
    block?: bigint,
  ): Promise<(ChangeState | undefined)[]> {
    const groups = cs.map((c) => changeCalls(c, accountOf(c)));
    // Only the non-empty groups are read: a vault setting's pending time is
    // not readable, and an account with no vault holds no vault change.
    const read = groups.flatMap((g, i) => (g !== null && g.length > 0 ? [i] : []));
    const got = await this.r.groups(read.map((i) => groups[i]!), block === undefined ? 'changes' : 'changes-final', block);
    const answers = new Map(read.map((i, j) => [i, got[j]]));
    return cs.map((c, i) => (groups[i] === null ? undefined : changeState(c, answers.get(i) ?? [])));
  }

  private isEvent(log: { topics: readonly string[]; address: string }, name: string, id: bigint): boolean {
    return log.address.toLowerCase() === this.r.diamond.toLowerCase() && eventIdOf(log, name) === id;
  }

  private delivered(receipt: StepSender['receipt'], id: bigint): bigint {
    for (const log of receipt?.logs ?? []) {
      if (log.address.toLowerCase() !== this.r.diamond.toLowerCase()) continue;
      const d = payoutDelivered(log, id);
      if (d !== null) return d;
    }
    return 0n;
  }
}

/** A change's record from its group's answers ({@link changeCalls});
 *  undefined when any of them did not come back. */
function changeState(c: Change, got: readonly unknown[]): ChangeState | undefined {
  if (got.some((x) => x === undefined)) return undefined;
  // Nothing to read: an account with no vault holds no vault change.
  if (c.t !== 'setting' && got.length === 0) return { t: 'none' };
  switch (c.t) {
    case 'setting':
      return c.kind === CHANGE_COSIGN_OFF ? { t: 'cosign', protection: got[0] as DiamondProtection } : { t: 'vaultSetting' };
    case 'allow':
      return { t: 'allow', entry: got[0] as AllowEntry, pending: got[1] as PendingAdditions };
    case 'signerAdd':
    case 'signerRemove':
      return { t: 'signer', entry: got[0] as SignerChange, pending: got[1] as PendingAdditions };
    case 'replace':
      return { t: 'replace', proposal: got[0] as ReplacementProposal };
  }
}

/** The reads of each change's own pending record: the Diamond's for the
 *  co-sign switch-off, the account's vault's for the rest (none for a vault
 *  setting: its pending time is not readable). Null when the account's vault
 *  is not known yet; an account with no vault has no vault-held change, and
 *  its record reads as none pending. */
function changeCalls(c: Change, a: ProtectedAccount | undefined): ReadCall[] | null {
  if (c.t === 'setting') {
    if (c.kind === CHANGE_COSIGN_OFF) return [protectionRead(c.account)];
    return [];
  }
  if (a === undefined) return null;
  if (noVault(a)) return [];
  const at = a.vault;
  switch (c.t) {
    case 'allow':
      return [
        { functionName: 'allowEntry', args: [c.other], address: at },
        { functionName: 'pendingAdditions', args: [], address: at },
      ];
    case 'signerAdd':
    case 'signerRemove':
      return [
        { functionName: 'signerEntry', args: [c.other], address: at },
        { functionName: 'pendingAdditions', args: [], address: at },
      ];
    case 'replace':
      return [{ functionName: 'replacementProposal', args: [], address: at }];
  }
}

/** Whether applying `c` changes the account's posture, so the Diamond's
 *  `applyProtection` follows it: an unlock or a switch-off (both applied by
 *  the vault's `finalizeSettings`), or a replacement. */
function changesPosture(c: Change): boolean {
  return c.t === 'replace' || (c.t === 'setting' && VAULT_SETTINGS.has(c.kind));
}

/** The accounts the page's events name (`PayoutQueued` and
 *  `PositionTransferQueued` both carry it), so their settings are read with
 *  the rows' own records. */
/** A read and the account whose settings go with it (null: none named). */
type AccountCall = { functionName: string; args: readonly unknown[]; account: Address | null };

/** The account the event that first named each nominee names, by nominee. */
function accountsNamed(page: LedgerRotation<bigint>): Map<bigint, Address> {
  const out = new Map<bigint, Address>();
  page.rows.forEach((row, i) => {
    const id = page.named[i];
    const a = id === null ? null : lower(row.args.account);
    if (id !== null && a !== null && !out.has(id)) out.set(id, a);
  });
  return out;
}

/** What a change's own record read returns. */
type ChangeState =
  | { t: 'cosign'; protection: DiamondProtection }
  | { t: 'vaultSetting' }
  | { t: 'allow'; entry: AllowEntry; pending: PendingAdditions }
  | { t: 'signer'; entry: SignerChange; pending: PendingAdditions }
  | { t: 'replace'; proposal: ReplacementProposal }
  | { t: 'none' };

const listed = (xs: readonly Address[], who: Address): boolean => xs.some((x) => lower(x) === who);

/** The pending time the chain holds now for the change a row announced. A
 *  change is still the row's own only while this equals the row's time.
 *  Null when the chain does not expose it (a vault setting change, #3379
 *  B2): neither due nor finished, so it is never sent and never settled. */
export function pendingAt(c: Change, s: ChangeState): bigint | null {
  if (s.t === 'none') return 0n;
  switch (c.t) {
    case 'setting':
      if (s.t === 'cosign') return BigInt(s.protection[2]);
      // NFT protection's switch-off was retired by #3318: nothing holds it.
      if (c.kind === 3) return 0n;
      return null;
    case 'allow': {
      if (s.t !== 'allow') return null;
      // An addition is pending only while it is listed for the current epoch
      // (a lock, a replacement or a switch-off voids it) and not yet active.
      return !s.entry.active && listed(s.pending[0], c.other) ? BigInt(s.entry.readyAt) : 0n;
    }
    case 'signerAdd':
      if (s.t !== 'signer') return null;
      return listed(s.pending[1], c.other) ? BigInt(s.entry.addAt) : 0n;
    case 'signerRemove':
      if (s.t !== 'signer') return null;
      return BigInt(s.entry.removeAt);
    case 'replace': {
      if (s.t !== 'replace') return null;
      const [nominee, , readyAt] = s.proposal;
      // A different nominee, or none, is no longer this row's proposal.
      return lower(nominee) === c.other ? BigInt(readyAt) : -1n;
    }
  }
}

// ─── Receipt logs ───────────────────────────────────────────────────────────

/** A receipt log, as far as the decoding here reads it. */
type ReceiptLog = { address: string; topics: readonly string[]; data?: string };

/** The vault's `SETTINGS_*` action of each vault-held setting kind. */
const VAULT_SETTING_ACTION: Readonly<Record<number, number>> = { 2: 2, 5: 4 };

/** Whether the receipt's logs carry the event that APPLYING `c` emits. The
 *  co-sign switch-off is the Diamond's: `SettingChangeApplied` for the
 *  account, from this Diamond. Every other change is the account's vault's
 *  (#3379 B2), whose events name no account: they must come from `vault`
 *  itself — `ProtectionSettingApplied` with the matching action
 *  (`ProtectionDisabled` for the switch-off), `AllowlistAdded`,
 *  `SignerAdded`, `SignerRemoved` for its destination or signer, or
 *  `PrimaryReplaced` naming the nominee as the new owner. Pure. Exported for
 *  the tests. */
export function changeApplied(logs: readonly ReceiptLog[], diamond: Address, vault: Address, c: Change): boolean {
  const fromDiamond = c.t === 'setting' && c.kind === CHANGE_COSIGN_OFF;
  const source = (fromDiamond ? diamond : vault).toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== source) continue;
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi: ABI, data: (log.data ?? '0x') as Hex, topics: log.topics as [Hex, ...Hex[]] }) as unknown as typeof ev;
    } catch {
      continue;
    }
    const a = ev.args;
    switch (c.t) {
      case 'setting':
        if (fromDiamond) {
          if (ev.eventName === 'SettingChangeApplied' && lower(a.account as Address) === c.account && Number(a.kind) === c.kind) return true;
        } else if (c.kind === CHANGE_DISABLE) {
          if (ev.eventName === 'ProtectionDisabled') return true;
        } else if (ev.eventName === 'ProtectionSettingApplied' && Number(a.action) === VAULT_SETTING_ACTION[c.kind]) {
          return true;
        }
        break;
      case 'allow':
        if (ev.eventName === 'AllowlistAdded' && lower(a.destination as Address) === c.other) return true;
        break;
      case 'signerAdd':
        if (ev.eventName === 'SignerAdded' && lower(a.signer as Address) === c.other) return true;
        break;
      case 'signerRemove':
        if (ev.eventName === 'SignerRemoved' && lower(a.signer as Address) === c.other) return true;
        break;
      case 'replace':
        if (ev.eventName === 'PrimaryReplaced' && lower(a.newOwner as Address) === c.other) return true;
        break;
    }
  }
  return false;
}

function eventIdOf(log: { topics: readonly string[]; data?: string }, name: string): bigint | null {
  try {
    const ev = decodeEventLog({ abi: ABI, data: (log.data ?? '0x') as Hex, topics: log.topics as [Hex, ...Hex[]] });
    if (ev.eventName !== name) return null;
    return BigInt((ev.args as unknown as { id: bigint }).id);
  } catch {
    return null;
  }
}

function payoutDelivered(log: { topics: readonly string[]; data?: string }, id: bigint): bigint | null {
  try {
    const ev = decodeEventLog({ abi: ABI, data: (log.data ?? '0x') as Hex, topics: log.topics as [Hex, ...Hex[]] });
    if (ev.eventName !== 'PayoutReleased') return null;
    const a = ev.args as unknown as { id: bigint; delivered: bigint };
    return BigInt(a.id) === id ? BigInt(a.delivered) : null;
  } catch {
    return null;
  }
}
