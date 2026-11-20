// apps/keeper/src/platformAlerts.ts
//
// #3719 — the platform's own alert. A user who came through another website
// sees only what that website showed them; this pass tells them, from the
// chain itself, what was actually recorded:
//
//   - every loan opened, to both parties, with its true terms (what was lent,
//     the collateral, the rate, the term), the website named as integrator
//     and every warning the contract derived (`warnings`);
//   - every offer posted or edited, and every Auto-lend slot whose rate terms
//     were set, to its owner, with the same facts;
//   - every step that lowers the user's protection: a higher asset access
//     level, consent to an illiquid pair, a keeper allowed to act (on the
//     account, a loan or an offer), a position token approved to another
//     address, and a request to unlock the position tokens or to shorten the
//     wait before they unlock.
//
// THE RULE for the protection steps: every event that lowers protection, or
// starts a wait that ends in less protection, alerts the wallet when it is
// requested, not when it takes effect. A later event of that kind joins
// `plan` under this rule without a new ruling (design thread, 2026-11-20).
// Steps that tighten protection alert nobody.
//
// The messages reach the agent as data (`TelegramAlert`); on Telegram the
// agent adds the owner's anti-phishing phrase (#3346). The keeper never holds
// the phrase, and the Push text, which the keeper renders, never shows it.
//
// The events are read from the chain, not from the indexer: like the vault
// security alerts (`protectedVaultEvents.ts`), these are safety alerts and do
// not depend on the indexer (owner decision via the design thread,
// 2026-11-20). One `eth_getLogs` per block range over the Diamond and the
// PositionNFT, whose addresses come from the deployment record, so no other
// contract can forge an event here. Where the step stopped is kept as a block
// and log position (and, for a loan, how many of its two parties were told),
// so a run cut short or a channel that asks for a retry never repeats an
// alert and never skips one. A first run starts at the head; a backlog wider
// than `TAIL_BACKLOG` blocks is jumped and counted.
//
// A fact the event does not carry is stated as unknown, never left out. An
// offer the same transaction turned into a loan (a slice taken by a fill, a
// signed offer made real as it was taken) is not announced on its own: the
// loan's alert says everything it would.
//
// The pass moves nothing and signs nothing. It ships disarmed
// (`PLATFORM_ALERTS_ENABLED`).

import { createPublicClient, erc20Abi, formatUnits, http, type Abi, type AbiEvent, type Address, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM, PositionNFTABI } from '@vaipakam/contracts/abis';
import { plainField, type TelegramAlert } from '@vaipakam/lib/telegramAlerts/message';
import type { ProtectionStep, TermsFields } from '@vaipakam/lib/telegramAlerts/platformCopy';
import { shortAddress } from '@vaipakam/lib/telegramAlerts/protectedCopy';
import { AlertDelivery } from './alertDelivery';
import { deadlineClient, PastRunDeadline } from './batchRead';
import { shortErr } from './callErrors';
import { listThresholdsForChain } from './db';
import { getChainConfigs, type ChainConfig, type Env } from './env';
import { decodePos, encodePos, type LedgerPos } from './eventLedger';
import { passIsArmed } from './keeper';
import { sendOwnerAlert, type OwnerAlertSendDeps } from './ownerAlertSend';
import type { PassTick } from './passSchedule';
import { positionNftForDiamond } from './positionNft';
import { d1ScanCursors, type ScanCursors } from './scanCursors';

/** The Diamond's events this pass alerts on. */
export const DIAMOND_EVENTS = [
  'LoanInitiated',
  'LoanInitiatedDetails',
  'OfferCreatedDetails',
  'OfferModified',
  'LenderIntentRateTermsSet',
  'VaultRiskTierSet',
  'IlliquidPairConsentSet',
  'KeeperActionsUpdated',
  'LoanKeeperEnabled',
  'OfferKeeperEnabled',
] as const;
/** The PositionNFT's. */
export const POSITION_EVENTS = ['Approval', 'HolderUnlockRequested', 'LockDelayLowerRequested'] as const;

export const TAIL_ITEM = 'platform-tail';
/** How many recipients of the log after `TAIL_ITEM` were told already. */
export const PART_ITEM = 'platform-part';
export const TAIL_SPAN = 2000n;
export const TAIL_CALLS = 3;
export const TAIL_BACKLOG = 20_000n;
const BLOCK_DONE = 2 ** 31;

export interface PlatformLog {
  kind: string;
  args: Record<string, unknown>;
  /** Which contract emitted it. */
  from: 'diamond' | 'position';
  block: number;
  log: number;
  tx: string;
}

/** An offer's assets, which `OfferModified` does not carry. */
export interface OfferAssets {
  lend: boolean;
  assetType: number;
  lendingAsset: Address;
  tokenId: bigint;
  collateralAssetType: number;
  collateralAsset: Address;
  collateralTokenId: bigint;
  durationDays: number;
}

export interface PlatformReads {
  head(): Promise<bigint>;
  /** The events in `[from, to]`. Throws when unread. */
  logs(from: bigint, to: bigint): Promise<PlatformLog[]>;
  /** An ERC-20's symbol and decimals; null when unread. */
  token(asset: Address): Promise<{ symbol: string; decimals: number } | null>;
  /** An offer's assets; null when unread. */
  offer(offerId: bigint): Promise<OfferAssets | null>;
  /** A slot's least rate (basis points); null when unread. */
  slotRate(owner: Address, lend: Address, coll: Address, slot: number): Promise<number | null>;
}

export interface PlatformDeps extends OwnerAlertSendDeps {
  reads: PlatformReads;
  cursors: ScanCursors;
  /** The step's cutoff (ms): no send starts at or past it. */
  cutoff: number;
}

export interface PlatformReport {
  sent: number;
  nobody: number;
  retrying: number;
  /** Logs that alert nobody (a tightening step, an offer a loan took). */
  quiet: number;
  skippedBlocks: number;
  unread: string | null;
}

/** One message: about `account`, to `to`. */
export interface Planned {
  account: Address;
  to: Address;
  alert: TelegramAlert;
}

const lower = (a: unknown): Address | null => {
  const s = String(a ?? '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) && !/^0x0{40}$/.test(s) ? (s as Address) : null;
};
const big = (v: unknown): bigint | null => {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  const s = String(v ?? '');
  return /^\d+$/.test(s) ? BigInt(s) : null;
};
const small = (v: unknown, max = 2 ** 40): number | null => {
  const b = big(v);
  return b === null || b > BigInt(max) ? null : Number(b);
};
const signed = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && Math.abs(n) <= 1_000_000 ? n : null;
};
const after = (a: LedgerPos, b: LedgerPos) => a.block > b.block || (a.block === b.block && a.log > b.log);
const field = (o: unknown, k: string): unknown => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[k] : undefined);

/** Longest number shown whole; a longer one keeps 10 digits at each end. */
const digits = (s: string): string => (s.length <= 24 ? s : `${s.slice(0, 10)}…${s.slice(-10)}`);

/** An asset written out: an amount (or range) with its token for an ERC-20,
 *  the token and id for an NFT, the token alone when no amount is given. */
async function describe(
  d: PlatformDeps,
  labels: Map<Address, { symbol: string; decimals: number } | null>,
  kind: number | null,
  asset: Address | null,
  tokenId: bigint | null,
  amount: bigint | null,
  amountMax: bigint | null = null,
): Promise<string | null> {
  if (asset === null || kind === null) return null;
  const at = shortAddress(asset);
  if (kind === 1) return plainField(`NFT ${at} #${digits(String(tokenId ?? '?'))}`);
  if (kind === 2) return plainField(`${amount === null ? '?' : digits(String(amount))} × ${at} #${digits(String(tokenId ?? '?'))}`);
  if (!labels.has(asset)) labels.set(asset, await d.reads.token(asset));
  const label = labels.get(asset)!;
  const symbol = label === null ? null : plainField(label.symbol);
  const fmt = (x: bigint) => digits(label === null ? String(x) : formatUnits(x, label.decimals));
  const unit = label === null ? `(raw units) ${at}` : `${symbol === null ? '?' : [...symbol].slice(0, 24).join('')} (${at})`;
  if (amount === null) return plainField(unit);
  const value = amountMax !== null && amountMax > amount ? `${fmt(amount)} – ${fmt(amountMax)}` : fmt(amount);
  return plainField(`${value} ${unit}`);
}

const integratorOf = (v: unknown): string | null => (v === undefined ? null : (lower(v) ?? (/^0x0{40}$/i.test(String(v)) ? 'none' : null)));

/**
 * The alerts one log makes, in order. `batch` is the log's own block range,
 * so a loan's `LoanInitiated` (its principal) is found beside its details,
 * which the Diamond emits in the same transaction. `null` when a read the
 * alert needs is not available yet (the step waits on it).
 */
export async function plan(
  d: PlatformDeps,
  l: PlatformLog,
  batch: readonly PlatformLog[],
  labels: Map<Address, { symbol: string; decimals: number } | null>,
): Promise<Planned[] | null> {
  const a = l.args;
  const protection = (wallet: Address | null, step: ProtectionStep, p: Partial<Extract<TelegramAlert, { kind: 'protectionLowered' }>>): Planned[] =>
    wallet === null
      ? []
      : [
          {
            account: wallet,
            to: wallet,
            alert: { kind: 'protectionLowered', step, subject: null, ref: null, lend: null, collateral: null, level: null, previous: null, seconds: null, at: null, ...p },
          },
        ];
  if (l.from === 'position') {
    switch (l.kind) {
      case 'Approval': {
        const approved = lower(a.approved);
        const id = big(a.tokenId);
        return approved === null ? [] : protection(lower(a.owner), 'tokenApproval', { subject: approved, ref: id === null ? null : String(id) });
      }
      case 'HolderUnlockRequested':
        return protection(lower(a.holder), 'positionUnlock', { at: small(a.executableAt) });
      case 'LockDelayLowerRequested':
        return protection(lower(a.holder), 'positionLockDelay', { seconds: small(a.newDelay), at: small(a.executableAt) });
      default:
        return [];
    }
  }
  switch (l.kind) {
    case 'LoanInitiatedDetails': {
      const det = a.details;
      const loanId = big(a.loanId);
      const lender = lower(a.lender);
      const borrower = lower(a.borrower);
      if (loanId === null) return [];
      const opened = batch.find((x) => x.kind === 'LoanInitiated' && x.tx === l.tx && big(x.args.loanId) === loanId);
      const tokenId = big(field(det, 'tokenId'));
      const terms: TermsFields = {
        // Without its LoanInitiated the principal is not known: the whole
        // line says unknown rather than name the asset without its amount.
        lend: opened ? await describe(d, labels, small(field(det, 'assetType'), 2), lower(field(det, 'principalAsset')), tokenId, big(opened.args.principal)) : null,
        collateral: await describe(
          d,
          labels,
          small(field(det, 'collateralAssetType'), 2),
          lower(field(det, 'collateralAsset')),
          big(field(det, 'collateralTokenId')),
          big(field(det, 'collateralAmount')),
        ),
        rateBps: small(field(det, 'interestRateBps'), 1_000_000),
        rateMaxBps: null,
        days: small(field(det, 'durationDays'), 100_000),
        marginBps: null,
        integrator: integratorOf(field(det, 'integrator')),
        warnings: small(field(det, 'warnings'), 7) ?? 0,
      };
      const out: Planned[] = [];
      if (lender) out.push({ account: lender, to: lender, alert: { kind: 'loanOpened', loanId: String(loanId), lender: true, terms } });
      if (borrower && borrower !== lender) out.push({ account: borrower, to: borrower, alert: { kind: 'loanOpened', loanId: String(loanId), lender: false, terms } });
      return out;
    }
    case 'OfferCreatedDetails': {
      const f = a.fields;
      const offerId = big(a.offerId);
      const creator = lower(a.creator);
      if (offerId === null || creator === null) return [];
      // Taken in the same transaction: the loan's alert covers it.
      if (batch.some((x) => x.kind === 'LoanInitiated' && x.tx === l.tx && big(x.args.offerId) === offerId)) return [];
      const lend = small(field(f, 'offerType'), 1) === 0;
      const linked = (small(field(f, 'linkKind'), 255) ?? 0) !== 0;
      const terms: TermsFields = {
        lend: await describe(d, labels, small(field(f, 'assetType'), 2), lower(a.lendingAsset), big(field(f, 'tokenId')), big(field(f, 'amount')), big(field(f, 'amountMax'))),
        collateral: await describe(
          d,
          labels,
          small(field(f, 'collateralAssetType'), 2),
          lower(field(f, 'collateralAsset')),
          null,
          big(field(f, 'collateralAmount')),
          big(field(f, 'collateralAmountMax')),
        ),
        rateBps: small(field(f, 'interestRateBps'), 1_000_000),
        rateMaxBps: small(field(f, 'interestRateBpsMax'), 1_000_000),
        days: small(field(f, 'durationDays'), 100_000),
        marginBps: linked ? signed(field(f, 'linkMarginBps')) : null,
        integrator: integratorOf(field(f, 'integrator')),
        warnings: small(field(f, 'warnings'), 7) ?? 0,
      };
      return [{ account: creator, to: creator, alert: { kind: 'offerPosted', offerId: String(offerId), edit: false, lend, terms } }];
    }
    case 'OfferModified': {
      const offerId = big(a.offerId);
      const creator = lower(a.creator);
      if (offerId === null || creator === null) return [];
      const o = await d.reads.offer(offerId);
      if (o === null) return null;
      const linked = (small(a.linkKind, 255) ?? 0) !== 0;
      const terms: TermsFields = {
        lend: await describe(d, labels, o.assetType, lower(o.lendingAsset), o.tokenId, big(a.amount), big(a.amountMax)),
        collateral: await describe(d, labels, o.collateralAssetType, lower(o.collateralAsset), o.collateralTokenId, big(a.collateralAmount), big(a.collateralAmountMax)),
        rateBps: small(a.interestRateBps, 1_000_000),
        rateMaxBps: small(a.interestRateBpsMax, 1_000_000),
        days: o.durationDays,
        marginBps: linked ? signed(a.linkMarginBps) : null,
        integrator: integratorOf(a.integrator),
        warnings: small(a.warnings, 7) ?? 0,
      };
      return [{ account: creator, to: creator, alert: { kind: 'offerPosted', offerId: String(offerId), edit: true, lend: o.lend, terms } }];
    }
    case 'LenderIntentRateTermsSet': {
      const owner = lower(a.owner);
      const lendAsset = lower(a.lendingAsset);
      const collAsset = lower(a.collateralAsset);
      const slot = small(a.slot, 255);
      if (owner === null || slot === null) return [];
      const linked = (small(a.linkKind, 255) ?? 0) !== 0;
      const terms: TermsFields = {
        lend: await describe(d, labels, 0, lendAsset, null, null),
        collateral: await describe(d, labels, 0, collAsset, null, null),
        rateBps: lendAsset && collAsset ? await d.reads.slotRate(owner, lendAsset, collAsset, slot) : null,
        rateMaxBps: null,
        days: null,
        marginBps: linked ? signed(a.linkMarginBps) : null,
        integrator: null,
        warnings: small(a.warnings, 7) ?? 0,
      };
      return [{ account: owner, to: owner, alert: { kind: 'slotTermsSet', slot, terms } }];
    }
    case 'VaultRiskTierSet': {
      const level = small(a.level, 255);
      const previous = small(a.previousLevel, 255);
      if (level === null || previous === null || level <= previous) return [];
      const at = small(a.usableFrom);
      return protection(lower(a.vault), 'riskLevel', { level, previous, at: at === 0 ? null : at });
    }
    case 'IlliquidPairConsentSet': {
      if (a.consent !== true) return [];
      const at = small(a.usableFrom);
      return protection(lower(a.vault), 'illiquidPair', {
        lend: await describe(d, labels, 0, lower(a.lendAsset), null, null),
        collateral: await describe(d, labels, 0, lower(a.collAsset), null, null),
        at: at === 0 ? null : at,
      });
    }
    case 'KeeperActionsUpdated': {
      const now = small(a.actions, 65535) ?? 0;
      const before = small(a.previousActions, 65535) ?? 0;
      if ((now & ~before) === 0) return [];
      return protection(lower(a.user), 'keeperActions', { subject: lower(a.keeper) });
    }
    case 'LoanKeeperEnabled':
    case 'OfferKeeperEnabled': {
      if (a.enabled !== true) return [];
      const id = big(l.kind === 'LoanKeeperEnabled' ? a.loanId : a.offerId);
      return protection(lower(a.owner), l.kind === 'LoanKeeperEnabled' ? 'loanKeeper' : 'offerKeeper', {
        subject: lower(a.keeper),
        ref: id === null ? null : String(id),
      });
    }
    default:
      return [];
  }
}

export async function platformAlerts(d: PlatformDeps): Promise<PlatformReport> {
  const report: PlatformReport = { sent: 0, nobody: 0, retrying: 0, quiet: 0, skippedBlocks: 0, unread: null };
  const head = await d.reads.head();
  const stored = await d.cursors.get([TAIL_ITEM, PART_ITEM]);
  let pos = decodePos(stored.get(TAIL_ITEM));
  if (pos === null) {
    // A first run starts at the head: it has no record of what was sent.
    await d.cursors.put(TAIL_ITEM, encodePos({ block: Number(head), log: BLOCK_DONE }));
    return report;
  }
  // `block:log:n` — n recipients of that log were told before a retry.
  const part = /^(\d+):(\d+):(\d+)$/.exec(stored.get(PART_ITEM) ?? '');
  let partAt = part ? { block: Number(part[1]), log: Number(part[2]), n: Number(part[3]) } : null;
  const save = async (p: LedgerPos) => {
    pos = p;
    await d.cursors.put(TAIL_ITEM, encodePos(p));
  };
  let from = BigInt(pos.log === BLOCK_DONE ? pos.block + 1 : pos.block);
  if (head - from > TAIL_BACKLOG) {
    const jump = head - TAIL_BACKLOG;
    report.skippedBlocks = Number(jump - from);
    from = jump;
    await save({ block: Number(jump) - 1, log: BLOCK_DONE });
  }
  const labels = new Map<Address, { symbol: string; decimals: number } | null>();
  for (let call = 0; call < TAIL_CALLS && from <= head; call++) {
    const to = from + TAIL_SPAN - 1n < head ? from + TAIL_SPAN - 1n : head;
    let logs: PlatformLog[];
    try {
      // eslint-disable-next-line no-await-in-loop
      logs = await d.reads.logs(from, to);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      report.unread = `the platform events of blocks ${from}-${to} (${shortErr(err)})`;
      return report;
    }
    const sorted = [...logs].sort((x, y) => x.block - y.block || x.log - y.log);
    for (const l of sorted) {
      if (!after(l, pos!)) continue;
      // eslint-disable-next-line no-await-in-loop
      const messages = await plan(d, l, sorted, labels);
      if (messages === null) {
        report.unread = `what ${l.kind} at block ${l.block} needs (an on-chain read)`;
        return report;
      }
      if (messages.length === 0) report.quiet += 1;
      const done = partAt !== null && partAt.block === l.block && partAt.log === l.log ? partAt.n : 0;
      for (let i = done; i < messages.length; i++) {
        if (Date.now() >= d.cutoff) throw new PastRunDeadline('platform alerts: the step reached its cutoff');
        const m = messages[i]!;
        // eslint-disable-next-line no-await-in-loop
        const result = await sendOwnerAlert(d, m.account, m.to, m.alert);
        if (result === 'retry') {
          report.retrying += 1;
          if (i > 0) {
            partAt = { block: l.block, log: l.log, n: i };
            // eslint-disable-next-line no-await-in-loop
            await d.cursors.put(PART_ITEM, `${l.block}:${l.log}:${i}`);
          }
          return report;
        }
        if (result === 'sent') report.sent += 1;
        else report.nobody += 1;
      }
      // eslint-disable-next-line no-await-in-loop
      await save({ block: l.block, log: l.log });
    }
    // eslint-disable-next-line no-await-in-loop
    await save({ block: Number(to), log: BLOCK_DONE });
    from = to + 1n;
  }
  return report;
}

export function describePlatformReport(chainId: number, r: PlatformReport): string {
  const parts = [`[keeper] platformAlerts chain=${chainId} sent=${r.sent} retrying=${r.retrying} nobody=${r.nobody} quiet=${r.quiet}`];
  if (r.skippedBlocks > 0) parts.push(`skipped-blocks=${r.skippedBlocks}`);
  if (r.unread) parts.push(`unread=${r.unread}`);
  return parts.join(' ');
}

// ─── Chain reads ────────────────────────────────────────────────────────────

const pick = (abi: Abi, names: readonly string[]): AbiEvent[] => {
  const seen = new Set<string>();
  return abi.filter((x): x is AbiEvent => {
    if (x.type !== 'event' || !names.includes(x.name) || seen.has(x.name)) return false;
    seen.add(x.name);
    return true;
  });
};
const DIAMOND_ITEMS = pick(DIAMOND_ABI_VIEM as Abi, DIAMOND_EVENTS);
const POSITION_ITEMS = pick(PositionNFTABI as Abi, POSITION_EVENTS);

/** Event names this pass reads that the exported ABIs do not carry. */
export const missingPlatformEvents = (): string[] => [
  ...DIAMOND_EVENTS.filter((n) => !DIAMOND_ITEMS.some((e) => e.name === n)),
  ...POSITION_EVENTS.filter((n) => !POSITION_ITEMS.some((e) => e.name === n)),
];

type RawLog = { eventName: string; args: Record<string, unknown>; blockNumber: bigint; logIndex: number; transactionHash: string };

export function chainPlatformReads(client: PublicClient, diamond: Address, nft: Address): PlatformReads {
  const one = (r: RawLog[], from: PlatformLog['from']): PlatformLog[] =>
    r.map((l) => ({ kind: l.eventName, args: l.args, from, block: Number(l.blockNumber), log: Number(l.logIndex), tx: String(l.transactionHash) }));
  return {
    head: () => client.getBlockNumber(),
    async logs(from, to) {
      const [dl, pl] = await Promise.all([
        client.getLogs({ address: diamond, events: DIAMOND_ITEMS, fromBlock: from, toBlock: to }),
        client.getLogs({ address: nft, events: POSITION_ITEMS, fromBlock: from, toBlock: to }),
      ]);
      return [...one(dl as unknown as RawLog[], 'diamond'), ...one(pl as unknown as RawLog[], 'position')];
    },
    async token(asset) {
      try {
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' }),
          client.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }),
        ]);
        return { symbol: String(symbol), decimals: Number(decimals) };
      } catch {
        return null;
      }
    },
    async offer(offerId) {
      try {
        const o = (await client.readContract({ address: diamond, abi: DIAMOND_ABI_VIEM as Abi, functionName: 'getOffer', args: [offerId] })) as Record<string, unknown>;
        return {
          lend: Number(o.offerType) === 0,
          assetType: Number(o.assetType),
          lendingAsset: o.lendingAsset as Address,
          tokenId: BigInt(o.tokenId as bigint),
          collateralAssetType: Number(o.collateralAssetType),
          collateralAsset: o.collateralAsset as Address,
          collateralTokenId: BigInt(o.collateralTokenId as bigint),
          durationDays: Number(o.durationDays),
        };
      } catch {
        return null;
      }
    },
    async slotRate(owner, lend, coll, slot) {
      try {
        const s = (await client.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM as Abi,
          functionName: 'getLenderIntent',
          args: [owner, lend, coll, slot],
        })) as Record<string, unknown>;
        return Number(s.minRateBps);
      } catch {
        return null;
      }
    },
  };
}

/** The pass: each chain's Diamond and PositionNFT, from where it stopped. */
export async function runPlatformAlerts(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'platformAlerts', 'PLATFORM_ALERTS_ENABLED')) return;
  const delivery = new AlertDelivery(env);
  const appOrigin = env.FRONTEND_ORIGIN ?? '';
  await Promise.all(
    getChainConfigs(env)
      .filter((c) => c.diamond)
      .map(async (chain: ChainConfig) => {
        try {
          const diamond = chain.diamond as Address;
          const client = deadlineClient(createPublicClient({ transport: http(chain.rpc) }) as PublicClient, tick.deadlineMs);
          let subs: Promise<Map<string, { push: boolean; locale: string | null }>> | null = null;
          const report = await platformAlerts({
            reads: chainPlatformReads(client, diamond, positionNftForDiamond(diamond).nft as Address),
            cursors: d1ScanCursors(env.KEEPER_DB, chain.id, chain.diamond as string, 'platformAlerts'),
            cutoff: tick.deadlineMs,
            chainId: chain.id,
            diamond,
            appOrigin,
            notify: (a) => delivery.deliver(a),
            subscriber: async (w) => {
              subs ??= listThresholdsForChain(env.DB, chain.id).then(
                (rows) => new Map(rows.map((r) => [r.wallet.toLowerCase(), { push: r.push_channel === 'subscribed', locale: r.locale ?? null }])),
              );
              return (await subs).get(w.toLowerCase()) ?? null;
            },
          });
          console.log(describePlatformReport(chain.id, report));
        } catch (err) {
          console.error(`[keeper] platformAlerts chain=${chain.id} failed: ${shortErr(err)}`);
        }
      }),
  );
  delivery.disclose('platformAlerts');
}
