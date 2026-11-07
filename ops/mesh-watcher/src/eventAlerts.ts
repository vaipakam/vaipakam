/**
 * Event alerts — the ops page for sanctions-list changes and governance
 * timelock operations (#3239 item 3, #3237).
 *
 * WHY. Everything else this Worker checks is a ledger RELATION: a figure
 * that should equal or bound another. These are not relations, they are
 * EVENTS an operator must hear about while they can still act:
 *
 * - A sanctions listing blocks a wallet's new positions and some of its
 *   claims and withdrawals. The automated adder key can apply one without
 *   a human, so a bad listing must be noticed in minutes, with its address
 *   count and source hash (#3239).
 * - A delisting proposal waits in `SanctionsDelistingTimelock` so the Safe
 *   can veto it; the wait is only useful if somebody is told it started.
 * - At mainnet every admin change waits in the governance timelock. That
 *   window is the main protection if the governance Safe is compromised,
 *   and until now nothing announced a queued operation (#3237).
 *
 * ONE GENERIC STEP. Each watched contract is a row of {@link WATCHED}: the
 * deployment key that names its address, the compiled ABI it decodes with,
 * and per event a severity, a title and the exact input shape the rule
 * was written against. The scan, the position bookkeeping and the
 * rendering are shared, so a new watched event is one row, not a new pass.
 *
 * HOW A TICK SCANS. Only the chain the rotation observes this tick, from
 * its stored position to the chain's FINALIZED block (a reorg can then
 * never alert an event that did not happen, or drop one that did), at most
 * {@link EventScanInput.logRange} blocks per contract. A contract scanned
 * for the first time starts {@link EventScanInput.initialLookback} blocks
 * back (never before the deploy block) and sends one advisory naming that
 * start, so nobody reads silence about earlier blocks as "nothing
 * happened".
 *
 * NOTHING IS SKIPPED. The position moves only past events whose alert was
 * delivered (see `deliver.ts` `delivered`). An alert Telegram refused is
 * read and sent again on the next tick of that chain. With no destination
 * configured nothing advances at all.
 *
 * READ-ONLY. The pass reads logs and one view. It sends no transaction.
 */

import type { Abi, AbiEvent, AbiFunction, Address, Hex, PublicClient } from 'viem';
import { keccak256, toHex } from 'viem';
import abiSubset from './abiSubset.json';
import type { CoverageGap } from './chains';
import { classify, describeFailure } from './errors';
import { makeFinding, type Finding, type Severity } from './finding';
import { MULTICALL3 } from './mesh';
import type { StoreOp } from './store';

/**
 * The codes of this pass's findings. Their alert records are kept through
 * the ordinary not-firing-any-more sweep and removed only once the scan
 * position has passed the event (`eventCursorWrites`).
 */
export const EVENT_ALERT_CODES: readonly string[] = ['event-alert', 'event-alert-start'];

/** The deployment keys of the watched contracts — also their cursor ids. */
export type WatchedContractId = 'sanctionsList' | 'sanctionsDelistingTimelock' | 'timelock';

interface EventRule {
  severity: Severity;
  title: string;
  /**
   * `name:type[:indexed]` per input, in order. Checked against the compiled
   * ABI by {@link eventAbiProblems}, so a contract change that alters what
   * an event means fails CI and the first tick instead of being alerted
   * under a stale title.
   */
  shape: readonly string[];
}

interface WatchedContract {
  id: WatchedContractId;
  /** Plain-words name for the alert. */
  label: string;
  /** Its compiled ABI file — and its key in `abiSubset.json`. */
  abiFile: 'SanctionsList' | 'SanctionsDelistingTimelock' | 'VaipakamTimelock';
  events: Readonly<Record<string, EventRule>>;
}

const OWNERSHIP_EVENTS = {
  OwnershipTransferStarted: {
    severity: 'critical',
    title: 'ownership transfer started',
    shape: ['previousOwner:address:indexed', 'newOwner:address:indexed'],
  },
  OwnershipTransferred: {
    severity: 'critical',
    title: 'ownership transferred',
    shape: ['previousOwner:address:indexed', 'newOwner:address:indexed'],
  },
} as const satisfies Record<string, EventRule>;

/**
 * What is watched, and how loudly.
 *
 * `critical` notifies: every listing update, every role or ownership
 * change, every delisting proposal and every newly queued timelock
 * operation, since each is a change an operator may need to stop.
 * `advisory` arrives silently: the outcomes of something already paged
 * (executed, cancelled) and routine tuning. Routine traffic the watcher
 * has no use for (clearance requests and answers, call salts) is not
 * read at all.
 */
export const WATCHED: readonly WatchedContract[] = [
  {
    id: 'sanctionsList',
    label: 'Sanctions list',
    abiFile: 'SanctionsList',
    events: {
      ListUpdated: {
        severity: 'critical',
        title: 'Sanctions list updated',
        shape: [
          'version:uint64:indexed',
          'sourceHash:bytes32:indexed',
          'sourcePublicationDate:uint32',
          'added:uint256',
          'removed:uint256',
          'listedCount:uint256',
          'updater:address:indexed',
        ],
      },
      AdderSet: {
        severity: 'critical',
        title: 'Sanctions list adder key changed',
        shape: ['account:address:indexed', 'enabled:bool'],
      },
      RemoverSet: {
        severity: 'critical',
        title: 'Sanctions list remover changed',
        shape: ['account:address:indexed', 'enabled:bool'],
      },
      AdderDailyAdditionCapSet: {
        severity: 'advisory',
        title: 'Sanctions list daily addition cap changed',
        shape: ['cap:uint32'],
      },
      PublicationRollbackAuthorized: {
        severity: 'critical',
        title: 'Sanctions list publication rollback authorized',
        shape: [
          'version:uint64:indexed',
          'publicationDate:uint32',
          'sourceHash:bytes32',
          'recordedDate:uint32',
          'recordedHash:bytes32',
        ],
      },
      PublicationRollbackApplied: {
        severity: 'critical',
        title: 'Sanctions list publication rolled back',
        shape: [
          'version:uint64:indexed',
          'fromDate:uint32',
          'fromHash:bytes32',
          'toDate:uint32',
          'toHash:bytes32',
        ],
      },
      PublicationRollbackCleared: {
        severity: 'advisory',
        title: 'Sanctions list rollback authorization cleared',
        shape: ['version:uint64:indexed', 'authorizedDate:uint32', 'authorizedHash:bytes32'],
      },
      OwnershipTransferStarted: { ...OWNERSHIP_EVENTS.OwnershipTransferStarted, title: 'Sanctions list ownership transfer started' },
      OwnershipTransferred: { ...OWNERSHIP_EVENTS.OwnershipTransferred, title: 'Sanctions list ownership transferred' },
    },
  },
  {
    id: 'sanctionsDelistingTimelock',
    label: 'Sanctions delisting timelock',
    abiFile: 'SanctionsDelistingTimelock',
    events: {
      DelistingProposed: {
        severity: 'critical',
        title: 'Sanctions delisting proposed (the Safe may veto before it executes)',
        shape: [
          'id:uint256:indexed',
          'proposer:address:indexed',
          'accounts:address[]',
          'sourceHash:bytes32',
          'publicationDate:uint32',
          'eta:uint64',
        ],
      },
      DelistingReconfirmed: {
        severity: 'advisory',
        title: 'Sanctions delisting proposal reconfirmed',
        shape: [
          'id:uint256:indexed',
          'previousSourceHash:bytes32',
          'previousPublicationDate:uint32',
          'sourceHash:bytes32',
          'publicationDate:uint32',
        ],
      },
      DelistingExecuted: {
        severity: 'advisory',
        title: 'Sanctions delisting executed',
        shape: ['id:uint256:indexed', 'by:address:indexed', 'route:uint8', 'listVersion:uint64'],
      },
      DelistingCancelled: {
        severity: 'advisory',
        title: 'Sanctions delisting cancelled',
        shape: ['id:uint256:indexed', 'by:address:indexed'],
      },
      DelistingDiscarded: {
        severity: 'advisory',
        title: 'Sanctions delisting discarded',
        shape: ['id:uint256:indexed', 'proposer:address:indexed', 'by:address:indexed'],
      },
      VetoSet: {
        severity: 'advisory',
        title: 'Sanctions delisting veto changed',
        shape: ['account:address:indexed', 'vetoed:bool', 'by:address:indexed'],
      },
      ProposerSet: {
        severity: 'critical',
        title: 'Sanctions delisting proposer changed',
        shape: ['account:address:indexed', 'enabled:bool'],
      },
      DelaySet: {
        severity: 'critical',
        title: 'Sanctions delisting delay changed',
        shape: ['previousDelay:uint32', 'newDelay:uint32'],
      },
      ClearanceSourceSet: {
        severity: 'critical',
        title: 'Sanctions delisting clearance source changed',
        shape: [
          'epoch:uint32:indexed',
          'messenger:address:indexed',
          'sourceChainId:uint256',
          'attestor:address:indexed',
        ],
      },
      OwnershipTransferStarted: { ...OWNERSHIP_EVENTS.OwnershipTransferStarted, title: 'Sanctions delisting timelock ownership transfer started' },
      OwnershipTransferred: { ...OWNERSHIP_EVENTS.OwnershipTransferred, title: 'Sanctions delisting timelock ownership transferred' },
    },
  },
  {
    id: 'timelock',
    label: 'Governance timelock',
    abiFile: 'VaipakamTimelock',
    events: {
      CallScheduled: {
        severity: 'critical',
        title: 'Governance change queued in the timelock',
        shape: [
          'id:bytes32:indexed',
          'index:uint256:indexed',
          'target:address',
          'value:uint256',
          'data:bytes',
          'predecessor:bytes32',
          'delay:uint256',
        ],
      },
      CallExecuted: {
        severity: 'advisory',
        title: 'Governance change executed from the timelock',
        shape: ['id:bytes32:indexed', 'index:uint256:indexed', 'target:address', 'value:uint256', 'data:bytes'],
      },
      Cancelled: {
        severity: 'advisory',
        title: 'Queued governance change cancelled',
        shape: ['id:bytes32:indexed'],
      },
      MinDelayChange: {
        severity: 'critical',
        title: 'Governance timelock delay changed',
        shape: ['oldDuration:uint256', 'newDuration:uint256'],
      },
      RoleGranted: {
        severity: 'critical',
        title: 'Governance timelock role granted',
        shape: ['role:bytes32:indexed', 'account:address:indexed', 'sender:address:indexed'],
      },
      RoleRevoked: {
        severity: 'critical',
        title: 'Governance timelock role revoked',
        shape: ['role:bytes32:indexed', 'account:address:indexed', 'sender:address:indexed'],
      },
      RoleAdminChanged: {
        severity: 'critical',
        title: 'Governance timelock role admin changed',
        shape: [
          'role:bytes32:indexed',
          'previousAdminRole:bytes32:indexed',
          'newAdminRole:bytes32:indexed',
        ],
      },
    },
  },
];

/** The one view the pass reads: the timelock's ready time for an operation. */
const TIMELOCK_VIEWS = ['getTimestamp'] as const;

type SubsetEntry = { type: string; name?: string; inputs?: { name: string; type: string; indexed?: boolean }[] };
const SUBSET = abiSubset as unknown as Record<string, SubsetEntry[]>;

/** Every subset entry the event pass needs — what `abiSubset.json` must carry for it. */
export const WATCHED_EVENT_ENTRIES: ReadonlyArray<{ facetFile: string; type: 'event' | 'function'; name: string }> = [
  ...WATCHED.flatMap((c) =>
    Object.keys(c.events).map((name) => ({ facetFile: c.abiFile, type: 'event' as const, name })),
  ),
  ...TIMELOCK_VIEWS.map((name) => ({ facetFile: 'VaipakamTimelock', type: 'function' as const, name })),
];

function abiOf(contract: WatchedContract): Abi {
  return (SUBSET[contract.abiFile] ?? []) as unknown as Abi;
}

const TIMELOCK_ABI = (SUBSET.VaipakamTimelock ?? []) as unknown as Abi;

/**
 * Every way the compiled ABI differs from what the rules assume. Empty
 * when they agree. `runTick` throws on a non-empty result before any read,
 * exactly as it does for the ledger views (`abi.ts` `assertAbiShape`).
 */
export function eventAbiProblems(subset: Record<string, SubsetEntry[]> = SUBSET): string[] {
  const problems: string[] = [];
  for (const contract of WATCHED) {
    const entries = subset[contract.abiFile] ?? [];
    for (const [name, rule] of Object.entries(contract.events)) {
      const matches = entries.filter((e) => e.type === 'event' && e.name === name);
      if (matches.length !== 1) {
        problems.push(`${contract.abiFile}.${name}: ${matches.length} event entries, expected exactly 1`);
        continue;
      }
      const actual = (matches[0]!.inputs ?? []).map(
        (i) => `${i.name}:${i.type}${i.indexed ? ':indexed' : ''}`,
      );
      if (actual.join(',') !== rule.shape.join(',')) {
        problems.push(
          `${contract.abiFile}.${name}: inputs are (${actual.join(', ')}), the rule expects (${rule.shape.join(', ')})`,
        );
      }
    }
  }
  const view = (subset.VaipakamTimelock ?? []).filter(
    (e) => e.type === 'function' && e.name === 'getTimestamp',
  ) as unknown as AbiFunction[];
  const shape =
    view.length === 1
      ? `${view[0]!.inputs.map((i) => i.type).join(',')}->${view[0]!.outputs.map((o) => o.type).join(',')}`
      : `${view.length} entries`;
  if (shape !== 'bytes32->uint256') {
    problems.push(`VaipakamTimelock.getTimestamp: is ${shape}, expected bytes32->uint256`);
  }
  return problems;
}

/** Throw on any {@link eventAbiProblems}. */
export function assertEventAbiShape(): void {
  const problems = eventAbiProblems();
  if (problems.length > 0) {
    throw new Error(
      `mesh-watcher event ABI drift — re-check the rules in src/eventAlerts.ts against the contracts before deploying:\n  ${problems.join('\n  ')}`,
    );
  }
}

// ── Scan ────────────────────────────────────────────────────────────────

/** The client surface the scan uses. `PublicClient` satisfies it. */
export type EventClient = Pick<PublicClient, 'getBlock' | 'getLogs' | 'multicall'>;

export interface EventScanInput {
  client: EventClient;
  chainId: number;
  /** Watched contracts present on this chain, by deployment key. */
  addresses: Partial<Record<WatchedContractId, Address>>;
  /** The deployment's deploy block — the floor of a first scan. */
  deployBlock: bigint | null;
  /** Stored next-block per contract (`event_cursor`). */
  cursors: ReadonlyMap<string, EventCursor>;
  logRange: bigint;
  initialLookback: bigint;
  /** Address → deployment key, for plain-words targets. */
  labels: ReadonlyMap<string, string>;
}

/**
 * A contract's stored scan position. `notified` is whether its first-scan
 * notice has reached the operator: until it has, the notice is sent again
 * on every scan, while the position itself is already fixed, so a retry
 * can never start later than the first attempt did.
 */
export interface EventCursor {
  nextBlock: bigint;
  notified: boolean;
}

/** One alerted event, with where it sits so the position can follow it. */
interface ScannedEvent {
  key: string;
  block: bigint;
}

export interface ContractScan {
  contract: WatchedContractId;
  address: Address;
  from: bigint;
  to: bigint;
  /** Set on a first scan: the key of the advisory naming where it started. */
  startNoticeKey: string | null;
  events: ScannedEvent[];
}

export interface EventScan {
  findings: Finding[];
  scans: ContractScan[];
  /** At most one per chain per tick; reported like any coverage gap. */
  gap: CoverageGap | null;
  /** Finalized blocks not yet read, summed over the contracts. */
  backlogBlocks: bigint;
}

/**
 * Well-known OpenZeppelin TimelockController roles, by hash. Built on first
 * use rather than at module load: most ticks render no role event, and the
 * cold-start CPU of this Worker is tight (Workers Free, 10 ms).
 */
let roleNames: ReadonlyMap<string, string> | null = null;
function roleName(hash: string): string | undefined {
  roleNames ??= new Map([
    [`0x${'0'.repeat(64)}`, 'DEFAULT_ADMIN_ROLE'],
    ...['PROPOSER_ROLE', 'EXECUTOR_ROLE', 'CANCELLER_ROLE', 'TIMELOCK_ADMIN_ROLE'].map(
      (r) => [keccak256(toHex(r)), r] as [string, string],
    ),
  ]);
  return roleNames.get(hash.toLowerCase());
}

const DURATION_FIELDS = new Set(['delay', 'previousDelay', 'newDelay', 'oldDuration', 'newDuration']);
const TIME_FIELDS = new Set(['eta']);
/** How many entries of an address list one alert prints before summarising. */
const LIST_LIMIT = 20;

function iso(seconds: bigint): string {
  const ms = Number(seconds) * 1000;
  return Number.isFinite(ms) && ms < 8.64e15 ? new Date(ms).toISOString() : `${seconds} (unix s)`;
}

function renderValue(
  field: string,
  type: string,
  value: unknown,
  labels: ReadonlyMap<string, string>,
): string {
  if (value === undefined) return '(could not be decoded)';
  if (type === 'address' && typeof value === 'string') {
    const label = labels.get(value.toLowerCase());
    return label ? `${value} (${label})` : value;
  }
  if (type === 'address[]' && Array.isArray(value)) {
    const shown = value.slice(0, LIST_LIMIT).map((v) => renderValue(field, 'address', v, labels));
    const more = value.length > LIST_LIMIT ? `, and ${value.length - LIST_LIMIT} more` : '';
    return `${value.length} address(es): ${shown.join(', ')}${more}`;
  }
  if (type === 'bytes' && typeof value === 'string') {
    const bytes = (value.length - 2) / 2;
    // The function a call runs is its first four bytes. Plain-words
    // decoding of the call is tracked on #3237 (the shared decoder).
    return bytes >= 4 ? `function selector ${value.slice(0, 10)}, ${bytes} bytes of calldata` : `${bytes} bytes`;
  }
  if (type === 'bytes32' && typeof value === 'string' && field.toLowerCase().includes('role')) {
    const name = roleName(value);
    return name ? `${name} (${value})` : value;
  }
  if (typeof value === 'bigint') {
    if (DURATION_FIELDS.has(field)) return `${value} s (${(Number(value) / 3600).toFixed(1)} h)`;
    if (TIME_FIELDS.has(field)) return `${iso(value)} (${value})`;
    return value.toString();
  }
  if (typeof value === 'number' && DURATION_FIELDS.has(field)) {
    return `${value} s (${(value / 3600).toFixed(1)} h)`;
  }
  return String(value);
}

/**
 * The timelock's ready time for an operation, in words. `getTimestamp` is
 * 0 for an operation that is unset or cancelled, 1 once it has executed,
 * and otherwise the earliest time it may execute.
 */
function readyText(ts: bigint | null): string {
  if (ts === null) return 'executable from: UNKNOWN — the timelock read failed; check the operation on chain';
  if (ts === 0n) return 'executable from: not pending any more (cancelled, or not found at the head block)';
  if (ts === 1n) return 'executable from: already executed';
  return `executable from: ${iso(ts)}`;
}

function gapOf(chainId: number, detail: string): CoverageGap {
  return { chainId, reason: 'no-rpc', source: 'event-logs', detail };
}

interface DecodedLog {
  eventName?: string;
  args?: Record<string, unknown> | readonly unknown[];
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

/**
 * Read and render the watched events on one chain.
 *
 * Never throws: a read that fails becomes the chain's one `event-logs`
 * coverage gap, which keeps the tick from reporting itself healthy, and
 * that contract's position does not move.
 */
export async function scanEvents(input: EventScanInput): Promise<EventScan> {
  const out: EventScan = { findings: [], scans: [], gap: null, backlogBlocks: 0n };
  const failures: string[] = [];

  const present = WATCHED.filter((c) => input.addresses[c.id] !== undefined);
  if (present.length === 0) return out;

  let finalized: bigint;
  try {
    const block = await input.client.getBlock({ blockTag: 'finalized' });
    if (block.number === null) throw new Error('the finalized block has no number');
    finalized = block.number;
  } catch (err) {
    out.gap = gapOf(
      input.chainId,
      `event alerts not read this tick — ${describeFailure(classify(err, `finalized block on chain ${input.chainId}`))}`,
    );
    return out;
  }

  const scheduled: { finding: number; id: Hex; base: string }[] = [];

  for (const contract of present) {
    const address = input.addresses[contract.id]!;
    const stored = input.cursors.get(contract.id);
    const floor = input.deployBlock ?? 0n;
    const lookbackStart = finalized > input.initialLookback ? finalized - input.initialLookback : 0n;
    const from = stored?.nextBlock ?? (floor > lookbackStart ? floor : lookbackStart);
    if (from > finalized) continue; // nothing finalized past the position yet
    const to = from + input.logRange - 1n < finalized ? from + input.logRange - 1n : finalized;
    out.backlogBlocks += finalized - to;

    const scan: ContractScan = { contract: contract.id, address, from, to, startNoticeKey: null, events: [] };

    let logs: DecodedLog[];
    try {
      const abiEvents = abiOf(contract).filter(
        (e): e is AbiEvent => e.type === 'event' && e.name in contract.events,
      );
      logs = (await input.client.getLogs({
        address,
        events: abiEvents,
        fromBlock: from,
        toBlock: to,
        strict: false,
      })) as unknown as DecodedLog[];
    } catch (err) {
      failures.push(
        `${contract.label}: ${describeFailure(classify(err, `event logs of ${contract.id} on chain ${input.chainId}`))}`,
      );
      continue;
    }

    if (stored === undefined || !stored.notified) {
      const notice = makeFinding({
        code: 'event-alert-start',
        once: true,
        variant: contract.id,
        severity: 'advisory',
        chainId: input.chainId,
        title: `${contract.label}: event alerts started`,
        identity: [contract.id, from.toString()],
        detail:
          `First scan of ${contract.label} (${address}). Reading from block ${from}` +
          (input.deployBlock !== null && from === input.deployBlock
            ? ', the deploy block, so every event since deployment is covered.'
            : `, ${input.initialLookback} finalized blocks back. Events BEFORE block ${from} are NOT reported by this watcher; read them on chain if they matter.`),
      });
      scan.startNoticeKey = notice.key;
      out.findings.push(notice);
    }

    for (const log of logs) {
      const rule = log.eventName ? contract.events[log.eventName] : undefined;
      const tx = log.transactionHash ?? '0x';
      const logIndex = log.logIndex ?? -1;
      const block = log.blockNumber ?? from;
      const args = (log.args ?? {}) as Record<string, unknown>;
      const lines = (rule?.shape ?? []).map((s) => {
        const [name, type] = s.split(':') as [string, string];
        return `  ${name} = ${renderValue(name, type, args[name], input.labels)}`;
      });
      const base =
        `${contract.label} ${address}\n` +
        `event: ${log.eventName ?? 'UNDECODABLE (a watched topic whose data did not decode)'}\n` +
        lines.join('\n') +
        `\nblock ${block} · tx ${tx}`;
      const finding = makeFinding({
        code: 'event-alert',
        once: true,
        variant: `${contract.id}.${log.eventName ?? 'undecodable'}@${tx}#${logIndex}`,
        // The event's own position: one alert per event, and a repeat of
        // the same event is the same alert.
        identity: [tx, logIndex],
        // A log that did not decode pages: it is a watched topic, and the
        // operator cannot tell from here which one.
        severity: rule?.severity ?? 'critical',
        chainId: input.chainId,
        title: rule?.title ?? `${contract.label}: watched event did not decode`,
        detail: base,
      });
      if (contract.id === 'timelock' && log.eventName === 'CallScheduled' && typeof args.id === 'string') {
        scheduled.push({ finding: out.findings.length, id: args.id as Hex, base });
      }
      out.findings.push(finding);
      scan.events.push({ key: finding.key, block });
    }
    out.scans.push(scan);
  }

  // When each queued operation may execute, from the timelock itself. One
  // request for all of them; a failed read is SAID, never left blank.
  const timelock = input.addresses.timelock;
  if (scheduled.length > 0 && timelock) {
    let ready: (bigint | null)[] = scheduled.map(() => null);
    try {
      const results = await input.client.multicall({
        contracts: scheduled.map((s) => ({
          address: timelock,
          abi: TIMELOCK_ABI,
          functionName: 'getTimestamp',
          args: [s.id] as never,
        })),
        allowFailure: true,
        multicallAddress: MULTICALL3,
        batchSize: 0,
      });
      ready = results.map((r) => (r.status === 'success' ? (r.result as bigint) : null));
    } catch {
      // Left UNKNOWN per operation; `readyText` says so in the alert.
    }
    scheduled.forEach((s, i) => {
      const f = out.findings[s.finding]!;
      out.findings[s.finding] = { ...f, detail: `${s.base}\n${readyText(ready[i] ?? null)}` };
    });
  }

  if (failures.length > 0) {
    out.gap = gapOf(input.chainId, `event alerts not read this tick for: ${failures.join('; ')}`);
  }
  return out;
}

/**
 * The position writes after delivery.
 *
 * Each scanned contract moves to the block of its EARLIEST undelivered
 * event, or past the scanned range when every event was delivered — so an
 * event whose alert did not reach the operator is read again next time,
 * and one that did is never sent twice.
 *
 * A first scan's start notice that was not delivered pins the position at
 * the scan's START and records the notice as owed (Codex #3301 r1 P1).
 * Writing nothing instead would let the next tick recompute the look-back
 * from a later finalized block and start past events this scan read but
 * could not deliver.
 */
export function eventCursorWrites(
  chainId: number,
  scan: EventScan,
  delivered: ReadonlySet<string>,
  at: number,
): StoreOp[] {
  const ops: StoreOp[] = [];
  for (const s of scan.scans) {
    const notified = s.startNoticeKey === null || delivered.has(s.startNoticeKey);
    const pending = s.events.filter((e) => !delivered.has(e.key)).map((e) => e.block);
    if (!notified) pending.push(s.from);
    const next = pending.length > 0 ? pending.reduce((a, b) => (b < a ? b : a)) : s.to + 1n;
    ops.push({ kind: 'setEventCursor', chainId, contract: s.contract, nextBlock: next, notified, at });
    // Records the position has now passed are never read again, so their
    // acknowledgements can go. Anything at or after the new position keeps
    // its record, whatever happens to the next read (Codex #3301 r3).
    const passed = s.events.filter((e) => e.block < next).map((e) => e.key);
    if (notified && s.startNoticeKey !== null) passed.push(s.startNoticeKey);
    if (passed.length > 0) ops.push({ kind: 'forgetAlerts', keys: passed });
  }
  return ops;
}
