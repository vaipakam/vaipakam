/**
 * Cross-tab Terms-acceptance sync (#2001).
 *
 * The defect this guards against: a second tab charging the wallet for
 * an acceptance the first tab already paid for. The frame parser and
 * the adopt decision are pure; the apply path runs against a real
 * QueryClient, which needs no DOM.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  applyAcceptancePinFrame,
  buildAcceptancePinFrame,
  parseAcceptancePinFrame,
  shouldAdoptPinnedVerdict,
  type AcceptancePinFrame,
} from './tosAcceptanceSync';
import { tosQueryKey, type TosVerdictData } from './tosGate';
import {
  __clearAcceptancePins,
  acceptanceIsPinned,
  acceptanceScope,
  ACCEPTANCE_PIN_TTL_MS,
} from './tosAcceptancePin';

const HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;
const ADDRESS = '0xAbCd000000000000000000000000000000000001';

function frame(overrides: Partial<AcceptancePinFrame> = {}): AcceptancePinFrame {
  return { ...buildAcceptancePinFrame(84532, ADDRESS, 3, HASH, 1_700_000_000_000), ...overrides };
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
    // Version 0 means "no ToS in force" — an acceptance of it cannot
    // exist, so a frame claiming one is malformed, not merely odd.
    expect(parseAcceptancePinFrame(frame({ version: 0 }))).toBeNull();
    expect(parseAcceptancePinFrame(frame({ version: 1.5 }))).toBeNull();
    expect(parseAcceptancePinFrame(frame({ hash: '0x1234' as never }))).toBeNull();
    expect(parseAcceptancePinFrame({ ...frame(), hash: `0x${'zz'.repeat(32)}` })).toBeNull();
    expect(parseAcceptancePinFrame(frame({ at: 0 }))).toBeNull();
    expect(parseAcceptancePinFrame({ ...frame(), at: Number.NaN })).toBeNull();
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
    expect(shouldAdoptPinnedVerdict(cachedAt(3), 3)).toBe(true);
    expect(shouldAdoptPinnedVerdict(cachedAt(3, true), 3)).toBe(true);
  });

  it('refuses an EMPTY cache — a frame does not establish version currency', () => {
    // Review round 1 P1. The acting tab may seed its empty cache
    // because its receipt anchors the version (`acceptTerms` reverts
    // on a stale one); a frame proves only that the wallet accepted
    // that version at some point. Seeding `accepted: true` here would
    // be a fresh successful entry TanStack serves while the first real
    // read is in flight — the gate open under a version the wallet
    // never accepted, from a tab that never read the chain at all.
    expect(shouldAdoptPinnedVerdict(undefined, 3)).toBe(false);
  });

  it('refuses when the receiving tab has seen a different version', () => {
    // This tab knows a version the acting tab did not when it accepted
    // — governance installed a new one in between. Overwriting would
    // open the gate on terms the wallet never accepted.
    expect(shouldAdoptPinnedVerdict(cachedAt(4), 3)).toBe(false);
    expect(shouldAdoptPinnedVerdict(cachedAt(2), 3)).toBe(false);
  });
});

describe('applyAcceptancePinFrame', () => {
  it('pins with the ACTING tab’s timestamp, so the TTL does not restart', () => {
    const at = 1_700_000_000_000;
    const client = new QueryClient();
    applyAcceptancePinFrame(client, frame({ at }));

    const scope = acceptanceScope(84532, ADDRESS);
    // Just inside the acting tab's window: pinned.
    expect(acceptanceIsPinned(scope, 3, at + ACCEPTANCE_PIN_TTL_MS)).toBe(true);
    // Just past it: expired — even though THIS tab only just received
    // it. A reorged acceptance must stop being papered over at the
    // same moment in every tab.
    expect(acceptanceIsPinned(scope, 3, at + ACCEPTANCE_PIN_TTL_MS + 1)).toBe(false);
  });

  it('stores only the pin into an empty cache — never a verdict', () => {
    // Review round 1 P1: the tab that has never read the chain takes
    // the pin and nothing else; its FIRST real read adopts it exactly
    // when the chain still reports this version, through the same
    // queryFn correction every other read uses.
    const client = new QueryClient();
    applyAcceptancePinFrame(client, frame());
    expect(client.getQueryData(tosQueryKey(84532, ADDRESS))).toBeUndefined();
    expect(acceptanceIsPinned(acceptanceScope(84532, ADDRESS), 3, frame().at)).toBe(true);
  });

  it('overwrites a stale false at the same version', () => {
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
    applyAcceptancePinFrame(client, frame());
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(true);
  });

  it('leaves a newer version’s verdict alone but still stores the pin', () => {
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS);
    const newer: TosVerdictData = { accepted: false, version: 4, hash: HASH };
    client.setQueryData(key, newer);
    applyAcceptancePinFrame(client, frame({ version: 3 }));
    // The cache keeps the newer version's answer...
    expect(client.getQueryData(key)).toEqual(newer);
    // ...and the pin exists but can never match it, by the same
    // narrowing-by-matching rule the per-tab pin uses.
    const scope = acceptanceScope(84532, ADDRESS);
    expect(acceptanceIsPinned(scope, 3, frame().at)).toBe(true);
    expect(acceptanceIsPinned(scope, 4, frame().at)).toBe(false);
  });

  it('keys the cache write the way the reading tab does', () => {
    // `tosQueryKey` lowercases the address; the frame carries it as
    // connected. If the apply path built its own key spelling, the
    // write and the gate's read would miss each other silently.
    const client = new QueryClient();
    const key = tosQueryKey(84532, ADDRESS.toLowerCase());
    client.setQueryData<TosVerdictData>(key, { accepted: false, version: 3, hash: HASH });
    applyAcceptancePinFrame(client, frame({ address: ADDRESS.toUpperCase().replace('0X', '0x') }));
    expect(client.getQueryData<TosVerdictData>(key)?.accepted).toBe(true);
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
    applyAcceptancePinFrame(client, frame({ version: 4, at: v4At }));
    applyAcceptancePinFrame(client, frame({ version: 3, at: v4At - 5_000 }));
    expect(acceptanceIsPinned(scope, 4, v4At)).toBe(true);
    expect(acceptanceIsPinned(scope, 3, v4At)).toBe(false);
  });

  it('a duplicate frame at the same version cannot rewind the window', () => {
    // Same version, older timestamp: the existing pin's window stands.
    // A LATER same-version acceptance (the chain permits one) extends
    // it, anchored to a real receipt.
    const client = new QueryClient();
    const scope = acceptanceScope(84532, ADDRESS);
    const at = 1_700_000_000_000;
    applyAcceptancePinFrame(client, frame({ at }));
    applyAcceptancePinFrame(client, frame({ at: at - 60_000 }));
    expect(acceptanceIsPinned(scope, 3, at + ACCEPTANCE_PIN_TTL_MS)).toBe(true);
    applyAcceptancePinFrame(client, frame({ at: at + 30_000 }));
    expect(acceptanceIsPinned(scope, 3, at + 30_000 + ACCEPTANCE_PIN_TTL_MS)).toBe(true);
  });
});
