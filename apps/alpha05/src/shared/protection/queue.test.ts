import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import { OPEN } from '../eligibility/types';
import {
  destinationAllowed,
  holdsRole,
  orderByDue,
  queueClock,
  queueLogs,
  queueManager,
  queueVerdict,
  releaseCancels,
  ROW_CANCELLED,
  ROW_QUEUED,
  type AccountQueue,
  type QueueRow,
} from './queue';
import { destinationWords, measureQueueAction, queueReceipt, type QueueReview } from './queueReview';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const OWNER = '0x00000000000000000000000000000000000000aa' as Hex;
const SIGNER = '0x00000000000000000000000000000000000000bb' as Hex;
const OTHER = '0x00000000000000000000000000000000000000cc' as Hex;
const SAFE = '0x00000000000000000000000000000000000000dd' as Hex;
const WETH = '0x00000000000000000000000000000000000000e1' as Hex;
const NOW = 1_000_000;

const copy = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => `${k}${v ? JSON.stringify(v) : ''}` } as never;

function queue(over: Partial<AccountQueue> = {}, mode: Partial<NonNullable<AccountQueue['mode']>> = {}): AccountQueue {
  return {
    account: OWNER,
    mode: { enabled: true, locked: false, requireCosign: false, retired: false, delaySeconds: 172800, controller: OWNER, ...mode },
    signers: [SIGNER],
    allowlist: [SAFE],
    paused: false,
    escapeOpen: false,
    escapeOpensAt: 0,
    rows: [],
    chainNow: NOW,
    readAt: 1,
    ...over,
  };
}

function row(over: Partial<NonNullable<QueueRow['payout']>> = {}, id = 1n): QueueRow {
  return {
    id,
    code: 'ABCDEF',
    payout: { user: OWNER, state: ROW_QUEUED, kind: 0, asset: WETH, tokenId: 0n, amount: 100n, recipient: OWNER, releaseAt: NOW - 1, cosigned: false, needsCosign: null, ...over },
  };
}

const code = (v: ReturnType<typeof queueVerdict>) => (v.state === 'open' ? 'open' : v.state === 'unknown' ? 'unknown' : v.refusals[0]!.code);

describe('queue rules', () => {
  it('releases a due row, to anyone, in the contract order', () => {
    expect(code(queueVerdict('release', queue(), row(), OTHER, NOW, copy))).toBe('open');
    expect(code(queueVerdict('release', queue(), row({ releaseAt: NOW + 10 }), OTHER, NOW, copy))).toBe('PayoutNotDue');
    expect(queueVerdict('release', queue(), row({ releaseAt: NOW + 10 }), OTHER, NOW, copy).refusals[0]!.reopensAt).toBe(NOW + 10);
    expect(code(queueVerdict('release', queue({}, { locked: true }), row(), OTHER, NOW, copy))).toBe('ProtectedVaultLocked');
    expect(code(queueVerdict('release', queue({}, { requireCosign: true }), row(), OTHER, NOW, copy))).toBe('CosignRequired');
    expect(code(queueVerdict('release', queue({}, { requireCosign: true }), row({ cosigned: true }), OTHER, NOW, copy))).toBe('open');
    // Codex #3489 r2: the row's own reading of the release rule wins: an
    // unverified destination needs a co-sign with the setting off, and a
    // signerless account needs none with it on.
    expect(code(queueVerdict('release', queue(), row({ needsCosign: true }), OTHER, NOW, copy))).toBe('CosignRequired');
    expect(code(queueVerdict('release', queue({}, { requireCosign: true }), row({ needsCosign: false }), OTHER, NOW, copy))).toBe('open');
    expect(code(queueVerdict('release', queue(), row({ state: ROW_CANCELLED }), OTHER, NOW, copy))).toBe('RowNotQueued');
    expect(code(queueVerdict('release', queue(), row(), OTHER, null, copy))).toBe('unknown');
  });

  it('runs on the chain’s clock', () => {
    expect(queueClock({ chainNow: NOW, readAt: 1_000 }, 61_000)).toBe(NOW + 60);
    expect(queueClock({ chainNow: null, readAt: 1_000 }, 61_000)).toBeNull();
  });

  it('holds a release under a pause until the escape route opens', () => {
    const paused = queueVerdict('release', queue({ paused: true, escapeOpen: false, escapeOpensAt: NOW + 99 }), row(), OWNER, NOW, copy);
    expect(code(paused)).toBe('EnforcedPause');
    expect(paused.refusals[0]!.reopensAt).toBe(NOW + 99);
    expect(paused.switchClass).toBe('2');
    expect(code(queueVerdict('release', queue({ paused: true, escapeOpen: true }), row(), OWNER, NOW, copy))).toBe('open');
    expect(code(queueVerdict('release', queue({ paused: null }), row(), OWNER, NOW, copy))).toBe('unknown');
    // Cancelling keeps working during a pause.
    expect(code(queueVerdict('cancel', queue({ paused: true }), row(), OWNER, NOW, copy))).toBe('open');
  });

  it('opens a release that cancels a row whose destination is no longer allowed, before any time check', () => {
    const r = row({ recipient: OTHER, releaseAt: NOW + 1000 });
    expect(releaseCancels(queue(), r)).toBe(true);
    expect(code(queueVerdict('release', queue(), r, OTHER, NOW, copy))).toBe('open');
    expect(releaseCancels(queue(), row({ recipient: SAFE }))).toBe(false);
    expect(releaseCancels(queue({ allowlist: null }), row({ recipient: SAFE }))).toBeNull();
    expect(code(queueVerdict('release', queue({ allowlist: null }), row({ recipient: SAFE }), OTHER, NOW, copy))).toBe('unknown');
  });

  it('treats a retired account’s controller as its manager', () => {
    const q = queue({}, { retired: true, controller: SAFE });
    expect(queueManager(q)).toBe(SAFE);
    expect(destinationAllowed({ ...q, allowlist: [] }, SAFE)).toBe(true);
    expect(destinationAllowed({ ...q, allowlist: [] }, OWNER)).toBe(false);
    expect(code(queueVerdict('cancel', q, row(), SAFE, NOW, copy))).toBe('open');
    expect(code(queueVerdict('cancel', q, row(), OWNER, NOW, copy))).toBe('NotManagerOrSigner');
  });

  it('lets the manager or a signer cancel, and only a signer co-sign when required', () => {
    expect(code(queueVerdict('cancel', queue(), row(), SIGNER, NOW, copy))).toBe('open');
    expect(code(queueVerdict('cancel', queue(), row(), OTHER, NOW, copy))).toBe('NotManagerOrSigner');
    expect(code(queueVerdict('cancel', queue(), row({ state: ROW_CANCELLED }), OWNER, NOW, copy))).toBe('RowNotQueued');
    expect(code(queueVerdict('cosign', queue({}, { requireCosign: true }), row(), SIGNER, NOW, copy))).toBe('open');
    expect(code(queueVerdict('cosign', queue(), row({ needsCosign: true }), SIGNER, NOW, copy))).toBe('open');
    expect(code(queueVerdict('cosign', queue({}, { requireCosign: true }), row(), OWNER, NOW, copy))).toBe('NotSigner');
    expect(code(queueVerdict('cosign', queue({}, { requireCosign: true }), row({ cosigned: true }), SIGNER, NOW, copy))).toBe('AlreadyCosigned');
    expect(code(queueVerdict('cosign', queue(), row(), SIGNER, NOW, copy))).toBe('CosignNotRequired');
    expect(code(queueVerdict('cosign', queue({ signers: null }), row(), SIGNER, NOW, copy))).toBe('unknown');
    expect(holdsRole('cosign', queue(), OWNER)).toBe(false);
    expect(holdsRole('cancel', queue(), OWNER)).toBe(true);
    expect(holdsRole('release', queue(), OTHER)).toBe(true);
  });

  it('says a row it could not read is unknown, never closed or open', () => {
    const unread: QueueRow = { id: 3n, code: null, payout: null };
    for (const a of ['release', 'cancel', 'cosign'] as const) expect(code(queueVerdict(a, queue(), unread, OWNER, NOW, copy))).toBe('unknown');
  });

  it('orders the queue by when each row comes due, an unread row last', () => {
    const rows = orderByDue([row({ releaseAt: 30 }, 1n), { id: 2n, code: null, payout: null }, row({ releaseAt: 10 }, 3n), row({ releaseAt: 10 }, 0n)]);
    expect(rows.map((r) => r.id)).toEqual([0n, 3n, 1n, 2n]);
  });
});

function log(eventName: string, args: Record<string, unknown>): Log {
  const abi = VaultPayoutFacetABI as Abi;
  const event = abi.find((e) => e.type === 'event' && e.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((i) => args[i.name]),
  );
  return { address: DIAMOND, topics: topics as [Hex, ...Hex[]], data } as unknown as Log;
}
const released = (id: bigint, delivered: bigint) => log('PayoutReleased', { account: OWNER, id, asset: WETH, amount: 100n, delivered, recipient: OWNER });
const cancelled = (id: bigint) => log('PayoutCancelled', { account: OWNER, id, by: DIAMOND });
const cosigned = (id: bigint) => log('PayoutCosigned', { account: OWNER, id, signer: SIGNER });

function review(action: QueueReview['action'], over: Partial<QueueReview> = {}): QueueReview {
  const q = queue();
  const r = row();
  return { identity: '1:0xaa', action, account: OWNER, id: 1n, queue: q, row: r, cancels: action === 'release' ? false : null, verdict: OPEN, dryRun: null, readAt: 1, ...over };
}
const what = (v: bigint) => `${v} WETH`;

describe('queue outcome', () => {
  it('reads only the row’s own events', () => {
    const seen = queueLogs([released(2n, 100n), cancelled(1n)], DIAMOND, 1n);
    expect(seen.released).toBeNull();
    expect(seen.cancelled?.by.toLowerCase()).toBe(DIAMOND);
  });

  it('measures a release as paid, and flags a short delivery', () => {
    expect(measureQueueAction(review('release'), [released(1n, 100n)], DIAMOND, OWNER, what, copy)).toEqual([
      { status: 'done', label: 'queue.legReleased{"what":"100 WETH","destination":"queue.toYourWallet"}' },
    ]);
    expect(measureQueueAction(review('release'), [released(1n, 98n)], DIAMOND, OWNER, what, copy)[0]!.status).toBe('unknown');
    expect(measureQueueAction(review('release'), [], DIAMOND, OWNER, what, copy)[0]!.status).toBe('not-done');
  });

  it('measures a release that cancelled as done only when the review said it would', () => {
    expect(measureQueueAction(review('release', { cancels: true }), [cancelled(1n)], DIAMOND, OWNER, what, copy)[0]!.status).toBe('done');
    expect(measureQueueAction(review('release'), [cancelled(1n)], DIAMOND, OWNER, what, copy)[0]!.status).toBe('unknown');
  });

  it('flags a payment when the review promised a cancellation', () => {
    const out = measureQueueAction(review('release', { cancels: true }), [released(1n, 100n)], DIAMOND, OWNER, what, copy);
    expect(out[0]).toMatchObject({ status: 'unknown', reason: 'queue.paidUnexpected' });
  });

  it('calls a destination allowlisted only when the allowlist says so', () => {
    expect(destinationWords(queue(), SAFE, OWNER, copy)).toMatch(/^queue\.toOther/);
    expect(destinationWords(queue(), OTHER, OWNER, copy)).toMatch(/^queue\.toDisallowed/);
    expect(destinationWords(queue({ allowlist: null }), OTHER, OWNER, copy)).toMatch(/^queue\.toUnread/);
    expect(destinationWords(queue(), OWNER, OWNER, copy)).toBe('queue.toYourWallet');
    expect(destinationWords(queue(), OWNER, SIGNER, copy)).toMatch(/^queue\.toManager/);
  });

  it('measures a cancel and a co-sign from their events', () => {
    expect(measureQueueAction(review('cancel'), [cancelled(1n)], DIAMOND, OWNER, what, copy)[0]!.status).toBe('done');
    expect(measureQueueAction(review('cancel'), [], DIAMOND, OWNER, what, copy)[0]!.status).toBe('not-done');
    expect(measureQueueAction(review('cosign'), [cosigned(1n)], DIAMOND, SIGNER, what, copy)[0]!.status).toBe('done');
    expect(measureQueueAction(review('cosign'), [cosigned(2n)], DIAMOND, SIGNER, what, copy)[0]!.status).toBe('not-done');
  });

  it('states in the receipt that a release cancels, and names another account', () => {
    const r = queueReceipt(review('release', { cancels: true }), SIGNER, (e) => (e ? '100.000 WETH' : '100 WETH'), copy);
    expect(r.title).toBe('queue.titleRelease{"code":"ABCDEF"}');
    expect(r.rows.map((x) => x.label)).toContain('queue.rowAccount');
    expect(r.consequences[0]).toEqual({ text: 'queue.releaseCancels{"what":"100 WETH"}', exact: 'queue.releaseCancels{"what":"100.000 WETH"}' });
    expect(r.prompts).toBe(1);
    const unread = queueReceipt(review('release', { cancels: null }), OWNER, () => '100 WETH', copy);
    expect(unread.consequences).toContain('queue.allowUnread');
    expect(unread.rows.map((x) => x.label)).not.toContain('queue.rowAccount');
  });
});
