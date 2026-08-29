/**
 * Cross-tab Terms-acceptance sync (#2001).
 *
 * The defect this guards against: a second tab charging the wallet for
 * an acceptance the first tab already paid for. The frame parser and
 * the adopt decision are pure; the apply path runs against a real
 * QueryClient, which needs no DOM.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  applyAcceptancePinFrame,
  applyAcceptanceReadHint,
  buildAcceptancePinFrame,
  buildAcceptanceReadHintFrame,
  parseAcceptancePinFrame,
  parseAcceptanceReadHintFrame,
  shouldAdoptPinnedVerdict,
  type AcceptancePinFrame,
} from './tosAcceptanceSync';
import { MAX_VERDICT_AGE_MS, tosQueryKey, type TosVerdictData } from './tosGate';
import {
  __clearAcceptancePins,
  acceptanceIsPinned,
  acceptanceReconciling,
  acceptanceScope,
  ACCEPTANCE_PIN_TTL_MS,
} from './tosAcceptancePin';

const HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;
const ADDRESS = '0xAbCd000000000000000000000000000000000001';
// The REAL Base Sepolia Diamond from deployments.json — the receiver
// drops any frame not mined against the deployment this build reads,
// so the tests must speak with the configuration's own voice.
const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
// The default chain position frames carry — mined block and
// transaction index. Frame-vs-frame pin ordering runs on these
// (#2004 rounds 14–15).
const B0 = 4_200_000;
const TX0 = 7;

function frame(overrides: Partial<AcceptancePinFrame> = {}): AcceptancePinFrame {
  return {
    ...buildAcceptancePinFrame(
      84532,
      DIAMOND,
      ADDRESS,
      3,
      HASH,
      1_700_000_000_000,
      B0,
      TX0,
    ),
    ...overrides,
  };
}

afterEach(() => {
  __clearAcceptancePins();
});

describe('parseAcceptancePinFrame', () => {
  it('accepts a well-formed frame', () => {
    expect(parseAcceptancePinFrame(frame())).toEqual(frame());
  });

  it('round-trips through JSON, the storage-ping transport', () => {
    expect(parseAcceptancePinFrame(JSON.parse(JSON.stringify(frame())))).toEqual(frame());
  });

  it('rejects the legacy invalidation frame and junk', () => {
    // The rail carries two frame kinds; the invalidation frame has no
    // discriminator, so the parser must never claim it.
    expect(parseAcceptancePinFrame({ roots: ['myLoans'] })).toBeNull();
    expect(parseAcceptancePinFrame(null)).toBeNull();
    expect(parseAcceptancePinFrame('tos-acceptance-pin')).toBeNull();
    expect(parseAcceptancePinFrame(42)).toBeNull();
  });

  it('rejects a frame with any field malformed', () => {
    expect(parseAcceptancePinFrame(frame({ kind: 'other' as never }))).toBeNull();
    expect(parseAcceptancePinFrame({ ...frame(), chainId: '84532' })).toBeNull();
    expect(parseAcceptancePinFrame(frame({ chainId: 0 }))).toBeNull();
    expect(parseAcceptancePinFrame(frame({ address: '' }))).toBeNull();
    expect(parseAcceptancePinFrame({ ...frame(), diamond: '0x1234' })).toBeNull();
    expect(parseAcceptancePinFrame({ ...frame(), diamond: undefined })).toBeNull();
    // Version 0 means "no ToS in force" — an acceptance of it cannot
    // exist, so a frame claiming one is malformed, not merely odd.
    expect(parseAcceptancePinFrame(frame({ version: 0 }))).toBeNull();
    expect(parseAcceptancePinFrame(frame({ version: 1.5 }))).toBeNull();
    expect(parseAcceptancePinFrame(frame({ hash: '0x1234' as never }))).toBeNull();
    expect(parseAcceptancePinFrame({ ...frame(), hash: `0x${'zz'.repeat(32)}` })).toBeNull();
    expect(parseAcceptancePinFrame(frame({ at: 0 }))).toBeNull();
    expect(parseAcceptancePinFrame({ ...frame(), at: Number.NaN })).toBeNull();
    // Ordering runs on the chain position, so a frame without a
    // plausible one has nothing to be ordered by (#2004 rounds 14–15).
    // A transaction index of ZERO is real — the block's first
    // transaction — and must parse.
    expect(parseAcceptancePinFrame(frame({ block: 0 }))).toBeNull();
    expect(parseAcceptancePinFrame(frame({ block: 1.5 }))).toBeNull();
    expect(parseAcceptancePinFrame({ ...frame(), block: undefined })).toBeNull();
    expect(parseAcceptancePinFrame(frame({ txIndex: -1 }))).toBeNull();
    expect(parseAcceptancePinFrame(frame({ txIndex: 2.5 }))).toBeNull();
    expect(parseAcceptancePinFrame({ ...frame(), txIndex: undefined })).toBeNull();
    expect(parseAcceptancePinFrame(frame({ txIndex: 0 }))).toEqual(frame({ txIndex: 0 }));
  });
});

describe('acceptance read-hint frame', () => {
  // Round 35 P1: when the acting tab's anchor crossed a clock
  // discontinuity mid-flight, its pin frame would hand receivers a
  // wall-apparent window whose true age is unknowable — and a
  // receiver, never having observed the submission, cannot indict it.
  // The acting tab sends this NON-ADOPTABLE hint instead; the only
  // thing a receiver may do with it is run its authoritative reads.
  const hint = () => buildAcceptanceReadHintFrame(84532, DIAMOND, ADDRESS);

  it('parses a well-formed hint and rejects malformed ones', () => {
    expect(parseAcceptanceReadHintFrame(hint())).toEqual(hint());
    expect(parseAcceptanceReadHintFrame(JSON.parse(JSON.stringify(hint())))).toEqual(hint());
    // The pin frame is a different kind — neither parser claims the
    // other's frames.
    expect(parseAcceptanceReadHintFrame(frame())).toBeNull();
    expect(parseAcceptancePinFrame(hint())).toBeNull();
    expect(parseAcceptanceReadHintFrame(null)).toBeNull();
    expect(parseAcceptanceReadHintFrame({ ...hint(), chainId: '84532' })).toBeNull();
    expect(parseAcceptanceReadHintFrame({ ...hint(), chainId: 0 })).toBeNull();
    expect(parseAcceptanceReadHintFrame({ ...hint(), diamond: '0x1234' })).toBeNull();
    expect(parseAcceptanceReadHintFrame({ ...hint(), address: '' })).toBeNull();
  });

  it('applies as reads only — no pin, no cache write — and HOLDS the acceptance offer', () => {
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyAcceptanceReadHint(client, hint());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    invalidate.mockRestore();
    // The verdict and the pin store are untouched: an unanchorable
    // acceptance may ask for a read and nothing more.
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(false);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, Date.now())).toBe(
      false,
    );
    // Round 37 P1: while the hint's reads reconcile, the acceptance
    // OFFER is held — a lagging RPC's cached `false` must not keep an
    // enabled Accept button offering a redundant paid re-acceptance
    // that a pinless acceptance can no longer prevent.
    expect(acceptanceReconciling(acceptanceScope(84532, ADDRESS))).toBe(true);
  });

  it('drops a hint about a different Diamond, or an unknown chain', () => {
    // Same round-3 rule as the pin frame: a hint about a deployment
    // this build does not read proves nothing about the one it does.
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyAcceptanceReadHint(client, { ...hint(), diamond: `0x${'11'.repeat(20)}` });
    applyAcceptanceReadHint(client, { ...hint(), chainId: 999_983 });
    expect(invalidate).not.toHaveBeenCalled();
    invalidate.mockRestore();
  });
});

describe('shouldAdoptPinnedVerdict', () => {
  const cachedAt = (version: number, accepted = false): TosVerdictData => ({
    accepted,
    version,
    hash: HASH,
  });

  it('adopts only at a matching version', () => {
    // Acceptance is write-only on-chain, so at a matching version the
    // mined `true` can only be AHEAD of a cached `false`.
    expect(shouldAdoptPinnedVerdict(cachedAt(3), 3, HASH)).toBe(true);
    expect(shouldAdoptPinnedVerdict(cachedAt(3, true), 3, HASH)).toBe(true);
  });

  it('refuses an EMPTY cache — a frame does not establish version currency', () => {
    // Review round 1 P1. The acting tab may seed its empty cache
    // because its receipt anchors the version (`acceptTerms` reverts
    // on a stale one); a frame proves only that the wallet accepted
    // that version at some point. Seeding `accepted: true` here would
    // be a fresh successful entry TanStack serves while the first real
    // read is in flight — the gate open under a version the wallet
    // never accepted, from a tab that never read the chain at all.
    expect(shouldAdoptPinnedVerdict(undefined, 3, HASH)).toBe(false);
  });

  it('refuses when the receiving tab has seen a different version', () => {
    // This tab knows a version the acting tab did not when it accepted
    // — governance installed a new one in between. Overwriting would
    // open the gate on terms the wallet never accepted.
    expect(shouldAdoptPinnedVerdict(cachedAt(4), 3, HASH)).toBe(false);
    expect(shouldAdoptPinnedVerdict(cachedAt(2), 3, HASH)).toBe(false);
  });
});

describe('applyAcceptancePinFrame', () => {
  it('pins with the ACTING tab’s timestamp, so the TTL does not restart', () => {
    const at = 1_700_000_000_000;
    const client = new QueryClient();
    applyAcceptancePinFrame(client, frame({ at }), at);

    const scope = acceptanceScope(84532, ADDRESS);
    // Just inside the acting tab's window: pinned.
    expect(acceptanceIsPinned(scope, 3, HASH, at + ACCEPTANCE_PIN_TTL_MS)).toBe(true);
    // Just past it: expired — even though THIS tab only just received
    // it. A reorged acceptance must stop being papered over at the
    // same moment in every tab.
    expect(acceptanceIsPinned(scope, 3, HASH, at + ACCEPTANCE_PIN_TTL_MS + 1)).toBe(false);
  });

  it('stores only the pin into an empty cache — never a verdict', () => {
    // Review round 1 P1: the tab that has never read the chain takes
    // the pin and nothing else; its FIRST real read adopts it exactly
    // when the chain still reports this version, through the same
    // queryFn correction every other read uses.
    const client = new QueryClient();
    applyAcceptancePinFrame(client, frame(), frame().at);
    expect(client.getQueryData(tosQueryKey(84532, ADDRESS))).toBeUndefined();
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, frame().at)).toBe(true);
  });

  it('overwrites a stale false at the same version', () => {
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    client.setQueryData<TosVerdictData>(
      key,
      { accepted: false, version: 3, hash: HASH },
      // Stamped on the same clock the frame is applied under — the
      // isVerdictStale future bound (round 19 P2) reads a stamp from
      // another era as non-authoritative, which is its job.
      { updatedAt: frame().at },
    );
    applyAcceptancePinFrame(client, frame(), frame().at);
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(true);
  });

  it('a FRESH newer verdict refuses the whole frame — pin included', () => {
    // Round 5 P1 (superseding this test's round-1 shape, which stored
    // the pin). The cache guard alone was not enough: a stored v3 pin
    // waits for the invalidation to hit a lagging node still
    // reporting v3, and `queryFn` then turns that answer into a fresh
    // `accepted: true` over the KNOWN v4 refusal. A fresh read
    // outranks any frame from before it.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const newer: TosVerdictData = { accepted: false, version: 4, hash: HASH };
    client.setQueryData(key, newer, { updatedAt: frame().at });
    applyAcceptancePinFrame(client, frame({ version: 3 }), frame().at);
    expect(client.getQueryData(key)).toEqual(newer);
    const scope = acceptanceScope(84532, ADDRESS);
    expect(acceptanceIsPinned(scope, 3, HASH, frame().at)).toBe(false);
    expect(acceptanceIsPinned(scope, 4, HASH, frame().at)).toBe(false);
  });

  it('a FRESH LOWER verdict also refuses the whole frame', () => {
    // Round 13 P1: a rollback can restore older terms; a fresh
    // authoritative v3 read plus a delayed orphaned v4 frame would
    // otherwise install a v4 pin that a node still on the orphaned
    // branch launders into accepted:true. Any fresh differing version
    // now refuses — read hint only.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const restored: TosVerdictData = { accepted: false, version: 3, hash: HASH };
    client.setQueryData(key, restored, { updatedAt: frame().at });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyAcceptancePinFrame(client, frame({ version: 4 }), frame().at);
    expect(client.getQueryData(key)).toEqual(restored);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 4, HASH, frame().at)).toBe(
      false,
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    invalidate.mockRestore();
  });

  it('a differing PIN-BACKED verdict does not refuse the frame — ordering decides, and the beaten verdict is aged', () => {
    // Round 16 P1: a pinBacked entry is this rail's own earlier
    // product, not a node's answer, and letting it outrank the next
    // frame double-counts hearsay — a tab whose v3 verdict came from
    // a frame would refuse the canonical v4 frame after a governance
    // bump and sit open under v3 until its own poll. The v3 pin
    // already sits in the ordering, which is the arbiter for hearsay
    // against hearsay; when the v4 frame wins there, the v3 verdict
    // it beat is aged immediately so the gates stop honouring it.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const at = Date.now();
    // Seed a pin-backed v3 verdict the way production creates one: a
    // v3 frame promoting a matching fresh refusal.
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
    applyAcceptancePinFrame(client, frame({ at }), at);
    expect(client.getQueryData<TosVerdictData>(key)?.pinBacked).toBe(true);
    // A canonical v4 frame from a later chain position arrives.
    const h4 = `0x${'44'.repeat(32)}` as `0x${string}`;
    applyAcceptancePinFrame(
      client,
      frame({ version: 4, hash: h4, at: at + 5_000, block: B0 + 2 }),
      at + 5_000,
    );
    const scope = acceptanceScope(84532, ADDRESS);
    expect(acceptanceIsPinned(scope, 4, h4, at + 6_000)).toBe(true);
    expect(acceptanceIsPinned(scope, 3, HASH, at + 6_000)).toBe(false);
    // The beaten v3 verdict is aged past the verdict bound — not
    // rewritten to v4 (the cache write still requires an exact match).
    const state = client.getQueryState<TosVerdictData>(key);
    expect(state?.data?.version).toBe(3);
    expect(state && Date.now() - state.dataUpdatedAt > MAX_VERDICT_AGE_MS).toBe(true);
  });

  it('the conflict guard uses the bare clock skew, not the render-tick slack', () => {
    // Round 25 P2: freshVerdict compares against REAL time, so the
    // 15-second render-tick allowance in the staleness default does
    // not apply — an entry stamped 6–20 seconds ahead (a backward
    // clock correction) must not stay authoritative against a
    // current frame.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const now = 1_700_000_000_000;
    client.setQueryData<TosVerdictData>(
      key,
      { accepted: false, version: 4, hash: HASH },
      { updatedAt: now + 10_000 },
    );
    applyAcceptancePinFrame(client, frame({ version: 3, at: now }), now);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, now)).toBe(true);
  });

  it('a FUTURE-dated cache entry is not authoritative — the frame still applies its pin', () => {
    // Round 19 P2: a backward clock correction after a read leaves
    // `dataUpdatedAt` ahead of the clock; counted as fresh, that
    // entry would veto valid frames (and receipts) until wall time
    // caught up plus the whole verdict window.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const now = 1_700_000_000_000;
    client.setQueryData<TosVerdictData>(
      key,
      { accepted: false, version: 4, hash: HASH },
      { updatedAt: now + 60_000 },
    );
    applyAcceptancePinFrame(client, frame({ version: 3, at: now }), now);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, now)).toBe(true);
    // The verdict itself is untouched — the freshness bar still gates
    // the cache write, and a non-fresh entry only ever keeps the pin.
    expect(client.getQueryData<TosVerdictData>(key)?.version).toBe(4);
  });

  it('retiring fork rivals also ages the orphaned pin-backed verdict', () => {
    // Round 20 P1: when rivals at one chain position leave neither pin
    // standing, the incumbent's fresh pinBacked verdict would
    // otherwise coast — its expiry timer reports superseded and exits
    // without aging — keeping both gates open for the rest of the
    // verdict window if the reads hang. Orphaned pin-backed verdicts
    // are aged in the refusal path itself.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const now = Date.now();
    // Incumbent: a v4 acceptance promoted over a matching fresh
    // refusal — pinBacked verdict plus pin.
    const h4 = `0x${'44'.repeat(32)}` as `0x${string}`;
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 4, hash: h4 });
    applyAcceptancePinFrame(client, frame({ version: 4, hash: h4, at: now }), now);
    expect(client.getQueryData<TosVerdictData>(key)?.pinBacked).toBe(true);
    // Rival: a different acceptance at the SAME (block, txIndex).
    applyAcceptancePinFrame(client, frame({ version: 3, at: now + 1_000 }), now + 1_000);
    const scope = acceptanceScope(84532, ADDRESS);
    expect(acceptanceIsPinned(scope, 4, h4, now + 2_000)).toBe(false);
    expect(acceptanceIsPinned(scope, 3, HASH, now + 2_000)).toBe(false);
    const state = client.getQueryState<TosVerdictData>(key);
    expect(state?.data?.version).toBe(4);
    expect(state && Date.now() - state.dataUpdatedAt > MAX_VERDICT_AGE_MS).toBe(true);
  });

  it('a fresh differing read refuses even a frame from a HIGHER block', () => {
    // Round 15 P1, withdrawing round 14's height carve-out: height is
    // not ancestry. A rollback can leave the canonical head BELOW an
    // orphaned acceptance's height, and treating the lower-height
    // fresh read as mere lag admitted exactly the orphaned frame this
    // guard exists to refuse. The differing fresh read always wins;
    // the frame is a read hint.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const canonical: TosVerdictData = { accepted: false, version: 3, hash: HASH };
    client.setQueryData(key, canonical, { updatedAt: frame().at });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyAcceptancePinFrame(client, frame({ version: 4, block: B0 + 5 }), frame().at);
    expect(client.getQueryData(key)).toEqual(canonical);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 4, HASH, frame().at)).toBe(
      false,
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    invalidate.mockRestore();
  });

  it('a STALE newer verdict does not refuse — the restored-version story stands', () => {
    // Round 5 P1's deliberate boundary: a >180s-old v4 read is not
    // authoritative about the present, and a v3 frame inside its 90s
    // window is consistent with the version having rolled back and
    // been re-accepted (the reorg case round 3 P2 protects). The pin
    // adopts; the verdict is still NOT promoted, because the stale
    // entry fails the freshness bar the verdict write requires.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 4, hash: HASH });
    const now = Date.now() + MAX_VERDICT_AGE_MS + 60_000;
    applyAcceptancePinFrame(client, frame({ version: 3, at: now - 1_000 }), now);
    expect(client.getQueryData<TosVerdictData>(key)?.version).toBe(4);
    const scope = acceptanceScope(84532, ADDRESS);
    expect(acceptanceIsPinned(scope, 3, HASH, now)).toBe(true);
  });

  it('keys the cache write the way the reading tab does', () => {
    // `tosQueryKey` lowercases the address; the frame carries it as
    // connected. If the apply path built its own key spelling, the
    // write and the gate's read would miss each other silently.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS.toLowerCase());
    client.setQueryData<TosVerdictData>(
      key,
      { accepted: false, version: 3, hash: HASH },
      { updatedAt: frame().at },
    );
    applyAcceptancePinFrame(client, frame({ address: ADDRESS.toUpperCase().replace('0X', '0x') }), frame().at);
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(true);
  });

  it('drops a frame mined against a different Diamond, or an unknown chain', () => {
    // Round 3 P1: chain ID and wallet do not identify a deployment.
    // During a rollout, an old tab and a new tab share this origin's
    // channel while reading DIFFERENT Diamonds, and Terms state is
    // per-Diamond — an acceptance on the retired one proves nothing
    // about the one this build reads.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
    applyAcceptancePinFrame(client, frame({ diamond: `0x${'11'.repeat(20)}` }), frame().at);
    applyAcceptancePinFrame(client, frame({ chainId: 999_983 }), frame().at);
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(false);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, frame().at)).toBe(false);
  });

  it('keeps only the pin when the matching cache is not fresh', () => {
    // Round 3 P1: `setQueryData` manufactures freshness — it stamps a
    // new `dataUpdatedAt` and turns error into success — so a stale
    // matching entry must not be promoted by a frame. The pin alone is
    // stored; the next real read adopts it iff the chain agrees.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
    // Advance the clock past the verdict-age bound: the entry, stamped
    // "now" by the line above, has aged out at apply time.
    const now = Date.now() + MAX_VERDICT_AGE_MS + 60_000;
    applyAcceptancePinFrame(client, frame({ at: now - 1_000 }), now);
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(false);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, now)).toBe(true);
  });

  it('an EXPIRED newer pin cannot block a fresh acceptance of a restored version', () => {
    // Round 3 P2: after a reorg rolls the canonical version back, the
    // dead v4 pin must not outrank a newly mined v3 acceptance for
    // ever. Past its bound a pin has no authority left to reject with.
    const client = new QueryClient();
    const scope = acceptanceScope(84532, ADDRESS);
    const t0 = 1_700_000_000_000;
    applyAcceptancePinFrame(client, frame({ version: 4, at: t0, block: B0 + 5 }), t0);
    const later = t0 + ACCEPTANCE_PIN_TTL_MS + 60_000;
    applyAcceptancePinFrame(client, frame({ at: later }), later);
    expect(acceptanceIsPinned(scope, 3, HASH, later)).toBe(true);
    expect(acceptanceIsPinned(scope, 4, HASH, later)).toBe(false);
  });

  it('refuses a frame whose HASH differs from the cached one at the same version', () => {
    // Round 4 P1: version monotonicity holds only within one branch. A
    // reorg can replace a governance update with different text at the
    // same number, and a frame from the orphaned branch must not
    // overwrite the canonical hash and claim acceptance of text the
    // wallet never saw — the contract compares both fields, so must we.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const canonicalHash = `0x${'55'.repeat(32)}` as `0x${string}`;
    client.setQueryData<TosVerdictData>(
      key,
      { accepted: false, version: 3, hash: canonicalHash },
      { updatedAt: frame().at },
    );
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyAcceptancePinFrame(client, frame(), frame().at);
    // Round 7 P2: refused, but still a read hint — the refused frame
    // may be the canonical one, and only a real read can tell.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    invalidate.mockRestore();
    const after = client.getQueryData<TosVerdictData>(key);
    expect(after?.accepted).toBe(false);
    expect(after?.hash).toBe(canonicalHash);
    // Round 6 P1 hardened this from a verdict guard into a whole-frame
    // refusal: the hash-A pin must not exist either, or a lagging
    // hash-A node plus queryFn would rewrite the canonical refusal on
    // the very next read.
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, frame().at)).toBe(
      false,
    );
  });

  it('rejects a frame timestamped in the future', () => {
    // Round 4 P1: accepted, a future `at` passes the age check on a
    // negative duration, and its pin never expires while outranking
    // every legitimate one — an unbounded gate bypass from one bad
    // timestamp.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
    const now = 1_700_000_000_000;
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyAcceptancePinFrame(client, frame({ at: now + 60_000 }), now);
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(false);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, now)).toBe(false);
    // Round 9 P2: a clock corrected backward can future-date a
    // LEGITIMATE acceptance, so the rejected frame is still a read
    // hint.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    invalidate.mockRestore();
  });

  it('an EXPIRED frame changes nothing but still triggers the authoritative reads', () => {
    // Round 4 P2: a tab frozen through the whole 90s window resumes
    // holding a cached refusal that can still be fresh under the 180s
    // verdict bound — dropping the late frame entirely left its
    // enabled Accept button standing until the next poll. The stale
    // frame is a read hint and nothing more.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const at = 1_700_000_000_000;
    applyAcceptancePinFrame(client, frame({ at }), at + ACCEPTANCE_PIN_TTL_MS + 1);
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(false);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, at)).toBe(false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    invalidate.mockRestore();
    // Round 37 P1: an out-of-window frame is exactly the evidence
    // that holds the acceptance offer while the reads reconcile —
    // the long-pending mine whose pin window has already passed.
    expect(acceptanceReconciling(acceptanceScope(84532, ADDRESS))).toBe(true);
  });

  it('never demotes a node-CONFIRMED verdict to pin-backed', () => {
    // Round 11 P2: a fresh accepted:true a node gave on its own has
    // earned its full freshness window; rewriting it pinBacked would
    // make it ageable at the frame pin's expiry — a gate flicker on a
    // slow refetch the confirmed entry should sit out.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    client.setQueryData<TosVerdictData>(key, { accepted: true, version: 3, hash: HASH });
    applyAcceptancePinFrame(client, frame(), frame().at);
    expect(client.getQueryData<TosVerdictData>(key)?.pinBacked).toBeUndefined();
  });

  it('poisoning wakes the expiry machinery immediately — no cadence wait', () => {
    // Round 29 P1: the heartbeat's poison used to change only
    // deadlines, leaving the pin-backed verdict trusted until the
    // expiry timer's next wake — up to a whole recheck cadence. The
    // poison now runs every live check at once: one beat after the
    // clocks disagree, the verdict is already aged.
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      const key = tosQueryKey(84532, ADDRESS);
      const t0 = Date.now();
      client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
      applyAcceptancePinFrame(client, frame({ at: t0 }), t0);
      expect(client.getQueryData<TosVerdictData>(key)?.pinBacked).toBe(true);
      // A 10-second backward correction while awake: the clocks
      // disagree at the next beat.
      vi.setSystemTime(t0 - 10_000);
      vi.advanceTimersByTime(10_500);
      // Aged at the beat itself — well inside the 30-second cadence.
      const aged = client.getQueryState<TosVerdictData>(key);
      expect(aged && Date.now() - aged.dataUpdatedAt > MAX_VERDICT_AGE_MS).toBe(true);
      expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, Date.now())).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a backward clock correction cannot extend the pin past its elapsed life', () => {
    // Round 26 P1, superseding round 11's wall-clock premise: the pin
    // carries a monotonic deadline stamped at adoption, and expiry is
    // EITHER bound. With the wall clock corrected 50s backward after
    // adoption, the wall window claims 50 extra seconds — but real
    // elapsed time keeps counting, and the timer ages the pin-backed
    // verdict on the elapsed schedule. (Vitest's fake timers advance
    // `performance.now` with the timer queue, which is exactly the
    // elapsed clock in question.)
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      const key = tosQueryKey(84532, ADDRESS);
      const t0 = Date.now();
      client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
      applyAcceptancePinFrame(client, frame({ at: t0 }), t0);
      // The wall clock is corrected 50s backward after scheduling.
      vi.setSystemTime(t0 - 50_000);
      vi.advanceTimersByTime(ACCEPTANCE_PIN_TTL_MS + 1_100);
      // Real elapsed time is past the TTL: the pin is dead by the
      // monotonic bound and the verdict aged, however the wall reads.
      const aged = client.getQueryState<TosVerdictData>(key);
      expect(aged && Date.now() - aged.dataUpdatedAt > MAX_VERDICT_AGE_MS).toBe(true);
      expect(
        acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, Date.now()),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a dead timer cannot age its replacement’s verdict', () => {
    // Round 10 P2: a later acceptance at the same version installs a
    // replacement pin and verdict; the FIRST acceptance's expiry timer
    // still fires, and matching on version alone would age the
    // replacement while its own window is still open — closing the
    // gates on a valid acceptance if the forced read then hangs.
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      const key = tosQueryKey(84532, ADDRESS);
      const t0 = Date.now();
      client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
      applyAcceptancePinFrame(client, frame({ at: t0 }), t0);
      // 30s later: a re-acceptance of the same version arrives.
      vi.advanceTimersByTime(30_000);
      applyAcceptancePinFrame(client, frame({ at: t0 + 30_000 }), t0 + 30_000);
      const freshAt = client.getQueryState<TosVerdictData>(key)?.dataUpdatedAt;
      // Advance past the FIRST timer's expiry but inside the second's
      // window: the replacement's verdict must be untouched.
      vi.advanceTimersByTime(ACCEPTANCE_PIN_TTL_MS - 30_000 + 1_100);
      expect(client.getQueryState<TosVerdictData>(key)?.dataUpdatedAt).toBe(freshAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a SUPERSEDED timer goes silent — no refetch under the replacement pin', () => {
    // Round 18 P2: with its pin replaced by a DIFFERENT version's, the
    // old timer's invalidation could hit a node still serving the
    // previous version — which the replacement pin cannot correct —
    // regressing the cache to an obsolete refusal. Superseded is not
    // expiry; the replacement's own machinery owns freshness now.
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      const key = tosQueryKey(84532, ADDRESS);
      const t0 = Date.now();
      client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
      applyAcceptancePinFrame(client, frame({ at: t0 }), t0);
      // 40s later a v4 acceptance replaces the v3 pin.
      vi.advanceTimersByTime(40_000);
      const h4 = `0x${'44'.repeat(32)}` as `0x${string}`;
      applyAcceptancePinFrame(
        client,
        frame({ version: 4, hash: h4, at: t0 + 40_000, block: B0 + 2 }),
        t0 + 40_000,
      );
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      // Advance past the v3 pin's original expiry (t0+90s) but inside
      // the v4 pin's window: the only invalidation in this stretch is
      // the v4 application's own 4-second second read — the v3 timer
      // fires, observes itself superseded, and does nothing.
      vi.advanceTimersByTime(55_000);
      expect(invalidate.mock.calls.length).toBe(1);
      invalidate.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a delayed OLDER frame cannot evict a newer pin', () => {
    // Review round 1 P2: BroadcastChannel delivery is not globally
    // ordered across senders, so a v3 frame can arrive after the v4
    // one. One pin per scope — an unconditional overwrite would leave
    // only the v3 pin, and the next lagging `false` read at v4 would
    // find nothing to correct it: prompt re-armed, second payment back
    // on the table.
    const client = new QueryClient();
    const scope = acceptanceScope(84532, ADDRESS);
    const v4At = 1_700_000_100_000;
    applyAcceptancePinFrame(client, frame({ version: 4, at: v4At, block: B0 + 2 }), v4At);
    applyAcceptancePinFrame(client, frame({ version: 3, at: v4At - 5_000 }), v4At);
    expect(acceptanceIsPinned(scope, 4, HASH, v4At)).toBe(true);
    expect(acceptanceIsPinned(scope, 3, HASH, v4At)).toBe(false);
  });

  it('a frame refused by ORDERING still triggers the authoritative reads', () => {
    // Round 8 P2: the incumbent pin can itself be from a branch a
    // reorg rolled back — an unexpired v4 pin against a canonical v3
    // the frame truthfully reports. The pin data is refused; the reads
    // run, because only they can decide which branch won.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const v4At = 1_700_000_100_000;
    applyAcceptancePinFrame(client, frame({ version: 4, at: v4At, block: B0 + 2 }), v4At);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyAcceptancePinFrame(client, frame({ version: 3, at: v4At - 5_000 }), v4At);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 4, HASH, v4At)).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    invalidate.mockRestore();
  });

  it('schedules a read just past the pin’s expiry', () => {
    // Round 8 P2: an orphaned acceptance has every in-window read
    // corrected to `true` by the live pin; without this read the last
    // corrected verdict coasts for up to the 60s poll after the pin
    // dies — a minute beyond the advertised bound.
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      const at = Date.now();
      applyAcceptancePinFrame(client, frame({ at }), at);
      const before = invalidate.mock.calls.length;
      vi.advanceTimersByTime(ACCEPTANCE_PIN_TTL_MS + 1_100);
      // The 4s second read AND the expiry read both fired.
      expect(invalidate.mock.calls.length).toBe(before + 2);
      invalidate.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('AGES a pin-backed verdict at expiry, and spares a node-confirmed one', () => {
    // Round 9 P2: a bare invalidation retains the successful
    // `accepted: true` and its freshness while the refetch is pending
    // — at ~91s the entry is far inside the 180s bound, so a hung
    // expiry read left both gates open toward another 89 seconds. A
    // verdict still resting on the pin is aged past the bound before
    // the re-read; one a node confirmed on its own is never touched.
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      const key = tosQueryKey(84532, ADDRESS);
      const at = Date.now();
      // Same-version cache → the receiver overwrites it pinBacked.
      client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
      applyAcceptancePinFrame(client, frame({ at }), at);
      expect(client.getQueryData<TosVerdictData>(key)?.pinBacked).toBe(true);
      vi.advanceTimersByTime(ACCEPTANCE_PIN_TTL_MS + 1_100);
      const aged = client.getQueryState<TosVerdictData>(key);
      expect(aged && Date.now() - aged.dataUpdatedAt > MAX_VERDICT_AGE_MS).toBe(true);

      // A node-confirmed verdict (no flag) written after the frame is
      // spared: re-run with the flagless entry replacing the flagged
      // one before expiry.
      const client2 = new QueryClient();
      applyAcceptancePinFrame(client2, frame({ at: Date.now() }), Date.now());
      client2.setQueryData<TosVerdictData>(key, { accepted: true, version: 3, hash: HASH });
      const confirmedAt = client2.getQueryState<TosVerdictData>(key)?.dataUpdatedAt;
      vi.advanceTimersByTime(ACCEPTANCE_PIN_TTL_MS + 1_100);
      expect(client2.getQueryState<TosVerdictData>(key)?.dataUpdatedAt).toBe(confirmedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a duplicate frame at the same version cannot rewind the window', () => {
    // Same version, older timestamp: the existing pin's window stands.
    // A LATER same-version acceptance (the chain permits one) extends
    // it, anchored to a real receipt.
    const client = new QueryClient();
    const scope = acceptanceScope(84532, ADDRESS);
    const at = 1_700_000_000_000;
    applyAcceptancePinFrame(client, frame({ at }), at);
    applyAcceptancePinFrame(client, frame({ at: at - 60_000 }), at);
    expect(acceptanceIsPinned(scope, 3, HASH, at + ACCEPTANCE_PIN_TTL_MS)).toBe(true);
    applyAcceptancePinFrame(client, frame({ at: at + 30_000 }), at + 30_000);
    expect(acceptanceIsPinned(scope, 3, HASH, at + 30_000 + ACCEPTANCE_PIN_TTL_MS)).toBe(true);
  });

  it('drops a frame delivered after its own safety window, whole', () => {
    // Review round 2 P1: a suspended tab can resume into a frame whose
    // 90 seconds have already passed. The pin would be rejected on its
    // first consultation anyway — the danger is the CACHE write, which
    // would manufacture a fresh `accepted: true` the gates serve while
    // the refetch runs. Past the bound the chain's answer must win in
    // every tab at once, so nothing of the frame applies.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const at = 1_700_000_000_000;
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
    applyAcceptancePinFrame(client, frame({ at }), at + ACCEPTANCE_PIN_TTL_MS + 1);
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(false);
    expect(
      acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, HASH, at + ACCEPTANCE_PIN_TTL_MS),
    ).toBe(false);
  });

  it('a frame refused by ordering applies NOTHING — not even to a matching cache', () => {
    // Review round 2 P1, re-staged after round 13: with a FRESH v3
    // refusal the v4 frame is now refused outright by the conflict
    // guard, so the ordering-refusal path is reachable only through a
    // STALE cache — the entry aged past the verdict bound, which the
    // conflict guard deliberately does not trust. A v4 frame then
    // installs its pin (verdict untouched, freshness bar), and the
    // straggling v3 frame is rejected by ordering; without the
    // whole-frame refusal the version guard would still match the v3
    // CACHE and rewrite it to `accepted: true` — the gates open under
    // terms this tab's own pin already knows are obsolete.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
    // The seeded entry is stamped with the real clock; applying with a
    // far-future `now` makes it stale at apply time.
    const now = Date.now() + MAX_VERDICT_AGE_MS + 60_000;
    applyAcceptancePinFrame(client, frame({ version: 4, at: now, block: B0 + 2 }), now);
    applyAcceptancePinFrame(client, frame({ version: 3, at: now - 5_000 }), now);
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(false);
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 4, HASH, now)).toBe(true);
  });
});
