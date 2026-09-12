/**
 * The page-head tracker, run under a fake page (#2120).
 *
 * Until #2120 this logic sat inside `live-position-observe.mjs`, which runs
 * the whole drive on import, so the rules below could only be asserted
 * against its SOURCE — `headSampling.test.mjs` still carries the shape pins
 * and the drive-side ordering. What a source guard cannot see is whether the
 * rule actually holds when the events arrive, in the orders a live page
 * produces them in. That is what this file is for.
 *
 * Every case is one rule the drive's forced-close bracket rests on, each one
 * a finding in its own right in the review rounds the tracker's notes cite:
 * heads are scoped to endpoints proven for the deployment (round 18), the
 * proof may arrive after the head (round 18, deferred resolution), a foreign
 * chain is excluded for the run and across pages (rounds 19, 51, 89, 108),
 * a contradiction is evidence (rounds 52, 79), parses in flight are drained
 * before a sample and the drain says whether it reached quiet (rounds 48,
 * 92, 96), the floor is proven per endpoint by an answer preceding an ask
 * (rounds 86, 90, 101), and the direct probes take the lowest for the floor
 * and the highest for the ceiling (rounds 87, 101).
 */
import { describe, expect, it } from 'vitest';

import { FakePage, FakeWebSocket } from './fakePage.mjs';
import { createPageHeadTracker } from './pageHead.mjs';
import { CHAIN_ID_CONFLICT } from './rpc-verdict.mjs';

const CHAIN_ID = 84532;
const CHAIN_HEX = '0x14a34';
const DIAMOND = `0x${'ab'.repeat(20)}`;
const EP = 'https://rpc.example/one';
const EP2 = 'https://rpc.example/two';

const call = (id, method, params = []) => ({ jsonrpc: '2.0', id, method, params });
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const diamondRead = (id = 1) => call(id, 'eth_call', [{ to: DIAMOND, data: '0x' }]);

/** A Playwright Request, as far as the tracker reads one. */
const request = (url, body, method = 'POST') => ({
  method: () => method,
  postData: () => (typeof body === 'string' ? body : JSON.stringify(body)),
  url: () => url,
});
/** A Playwright Response over `req`, whose body parses to `parsed`. */
const response = (req, parsed) => ({
  request: () => req,
  url: () => req.url(),
  json: async () => parsed,
});

/**
 * One tracker with a counting clock and a fetch the test supplies. The clock
 * is the ordering clock the drive would hand in; counting up per call is
 * enough, since the floor proof compares stamps and never reads them.
 */
function build({ fetch = async () => { throw new Error('fetch not expected'); } } = {}) {
  let tick = 0;
  const observedPageChain = new Map();
  const tracker = createPageHeadTracker({
    chainId: CHAIN_ID,
    diamondAddress: DIAMOND,
    observedPageChain,
    fetch,
    probeTimeoutMs: 1_000,
    now: () => {
      tick += 1;
      return tick;
    },
  });
  return { ...tracker, observedPageChain };
}

/** Emit a request and its response, the way a page's traffic arrives. */
function exchange(page, url, body, parsed) {
  const req = request(url, body);
  page.emit('request', req);
  page.emit('response', response(req, parsed));
}

/** Build, watch a page and hand both back. */
function watched(opts) {
  const t = build(opts);
  const page = new FakePage();
  t.watchPageHead(page);
  return { t, page };
}

/** A fetch answering per endpoint; anything unlisted throws, as a dead one would. */
const fetchAnswering = (byUrl, calls = []) =>
  async (url) => {
    calls.push(url);
    const answer = byUrl[url];
    if (answer === undefined) throw new Error(`no route for ${url}`);
    if (answer === 'http-error') return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => answer };
  };

describe('createPageHeadTracker', () => {
  it('refuses a mis-wired tracker by naming the argument', () => {
    const good = {
      chainId: CHAIN_ID,
      diamondAddress: DIAMOND,
      observedPageChain: new Map(),
      fetch: async () => {},
      probeTimeoutMs: 1,
      now: () => 0,
    };
    expect(() => createPageHeadTracker(good)).not.toThrow();
    for (const [key, bad] of [
      ['chainId', 0],
      ['chainId', '84532'],
      ['diamondAddress', DIAMOND.slice(2)],
      ['diamondAddress', undefined],
      ['observedPageChain', {}],
      ['fetch', undefined],
      ['probeTimeoutMs', 0],
      ['now', undefined],
    ]) {
      expect(() => createPageHeadTracker({ ...good, [key]: bad }), key).toThrow(
        new RegExp(`createPageHeadTracker: ${key}`),
      );
    }
  });
});

describe('heads are scoped to endpoints proven to serve the deployment', () => {
  it('records nothing for an endpoint that only announced heads', async () => {
    const { t, page } = watched();
    exchange(page, EP, call(1, 'eth_blockNumber'), reply(1, '0x64'));
    expect(await t.settleHeadReads(page)).toBe(true);
    expect(t.pageHeadOf(page)).toBe(0n);
    expect(t.pageHeadFloorOf(page)).toBe(0n);
    expect(t.diamondKeysOf(page).size).toBe(0);
  });

  it('resolves a head announced BEFORE the endpoint proved itself — resolution is deferred', async () => {
    const { t, page } = watched();
    exchange(page, EP, call(1, 'eth_blockNumber'), reply(1, '0x64'));
    exchange(page, EP, diamondRead(2), reply(2, '0x'));
    await t.settleHeadReads(page);
    expect(t.pageHeadOf(page)).toBe(100n);
    expect(t.pageHeadFloorOf(page)).toBe(100n);
    expect(t.isKnown(EP)).toBe(true);
  });

  it('resolves a head announced after the proof just the same', async () => {
    const { t, page } = watched();
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    exchange(page, EP, call(2, 'eth_blockNumber'), reply(2, '0x64'));
    await t.settleHeadReads(page);
    expect(t.pageHeadOf(page)).toBe(100n);
  });

  it('proves an endpoint through the calldata of a multicall, not only the `to`', async () => {
    // viem batches contract reads through multicall3, so the Diamond appears
    // only inside the encoded call — the common case, per the tracker's note.
    const { t, page } = watched();
    const multicall = call(1, 'eth_call', [
      { to: `0x${'cc'.repeat(20)}`, data: `0x252dba42${DIAMOND.slice(2)}` },
    ]);
    exchange(page, EP, multicall, reply(1, '0x'));
    exchange(page, EP, call(2, 'eth_blockNumber'), reply(2, '0x64'));
    await t.settleHeadReads(page);
    expect(t.pageHeadOf(page)).toBe(100n);
  });

  it('keeps the highest head and the lowest floor per endpoint', async () => {
    const { t, page } = watched();
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    for (const [id, head] of [
      [2, '0x64'],
      [3, '0x5a'],
      [4, '0x78'],
    ]) {
      exchange(page, EP, call(id, 'eth_blockNumber'), reply(id, head));
    }
    await t.settleHeadReads(page);
    expect(t.pageHeadOf(page)).toBe(120n);
    expect(t.pageHeadFloorOf(page)).toBe(90n);
  });

  it('resolves across endpoints: the highest proven head, the lowest proven floor', async () => {
    const { t, page } = watched();
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    exchange(page, EP2, diamondRead(1), reply(1, '0x'));
    exchange(page, EP, call(2, 'eth_blockNumber'), reply(2, '0x64'));
    exchange(page, EP2, call(2, 'eth_blockNumber'), reply(2, '0x66'));
    // A third endpoint, never proven, further along than either.
    exchange(page, 'https://ens.example', call(9, 'eth_blockNumber'), reply(9, '0xffff'));
    await t.settleHeadReads(page);
    expect(t.pageHeadOf(page)).toBe(102n);
    expect(t.pageHeadFloorOf(page)).toBe(100n);
  });

  it('reads `eth_getBlockByNumber` at latest as a head, and a pinned one as nothing', async () => {
    const { t, page } = watched();
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    exchange(
      page,
      EP,
      call(2, 'eth_getBlockByNumber', ['0x10', false]),
      reply(2, { number: '0x10' }),
    );
    await t.settleHeadReads(page);
    expect(t.pageHeadOf(page), 'a historical block is not an announcement').toBe(0n);
    exchange(
      page,
      EP,
      call(3, 'eth_getBlockByNumber', ['latest', false]),
      reply(3, { number: '0x70' }),
    );
    await t.settleHeadReads(page);
    expect(t.pageHeadOf(page)).toBe(112n);
  });

  it('ignores anything that is not a POST, and a body it cannot parse', async () => {
    const { t, page } = watched();
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    const get = request(EP, call(2, 'eth_blockNumber'), 'GET');
    page.emit('request', get);
    page.emit('response', response(get, reply(2, '0x64')));
    exchange(page, EP, '{not json', reply(3, '0x64'));
    await t.settleHeadReads(page);
    expect(t.pageHeadOf(page)).toBe(0n);
  });

  it('hears a head over a socket the page proved by what it sent', () => {
    const { t, page } = watched();
    const ws = new FakeWebSocket();
    page.emit('websocket', ws);
    ws.emit('framesent', { payload: JSON.stringify(diamondRead(1)) });
    ws.emit('framereceived', {
      payload: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: { subscription: '0x1', result: { number: '0x64' } },
      }),
    });
    // Socket frames are parsed synchronously; nothing to settle.
    expect(t.pageHeadOf(page)).toBe(100n);
    expect(t.diamondKeysOf(page).has(ws)).toBe(true);
  });

  it('hands back the proven endpoints as a copy', async () => {
    const { t, page } = watched();
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    await t.settleHeadReads(page);
    const keys = t.diamondKeysOf(page);
    expect([...keys]).toEqual([EP]);
    keys.clear();
    expect([...t.diamondKeysOf(page)]).toEqual([EP]);
  });
});

describe('an endpoint that answers for another chain is out for the run', () => {
  it('is excluded on the page that caught it, and the exclusion outlives the reply', async () => {
    const { t, page } = watched();
    exchange(page, EP, call(1, 'eth_chainId'), reply(1, '0x1'));
    await t.settleHeadReads(page);
    // The raw-address heuristic would admit this; the chain answer outranks it.
    exchange(page, EP, diamondRead(2), reply(2, '0x'));
    exchange(page, EP, call(3, 'eth_blockNumber'), reply(3, '0x64'));
    await t.settleHeadReads(page);
    expect(t.pageHeadOf(page)).toBe(0n);
    expect(t.diamondKeysOf(page).has(EP)).toBe(false);
    expect(t.isForeign(EP)).toBe(true);
    expect(t.isKnown(EP)).toBe(false);
    expect(t.observedPageChain.get(EP)).toBe(1);
  });

  it('revokes an admission the heuristic made first', async () => {
    const { t, page } = watched();
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    await t.settleHeadReads(page);
    expect(t.isKnown(EP)).toBe(true);
    exchange(page, EP, call(2, 'eth_chainId'), reply(2, '0x1'));
    await t.settleHeadReads(page);
    expect(t.diamondKeysOf(page).has(EP)).toBe(false);
    expect(t.isKnown(EP)).toBe(false);
    expect(t.isForeign(EP)).toBe(true);
  });

  it('stays out on a LATER page, whose own per-page evidence starts empty', async () => {
    const t = build();
    const first = new FakePage();
    t.watchPageHead(first);
    exchange(first, EP, call(1, 'eth_chainId'), reply(1, '0x1'));
    await t.settleHeadReads(first);

    const later = new FakePage();
    t.watchPageHead(later);
    exchange(later, EP, diamondRead(1), reply(1, '0x'));
    // Even the expected chain id, answered now, cannot re-admit an endpoint
    // that has already answered another — that inconsistency is the case
    // the rule exists for (round 51).
    exchange(later, EP, call(2, 'eth_chainId'), reply(2, CHAIN_HEX));
    exchange(later, EP, call(3, 'eth_blockNumber'), reply(3, '0x64'));
    await t.settleHeadReads(later);
    expect(t.diamondKeysOf(later).has(EP)).toBe(false);
    expect(t.pageHeadOf(later)).toBe(0n);
  });

  it('treats two different answers across two replies as a contradiction', async () => {
    const { t, page } = watched();
    exchange(page, EP, call(1, 'eth_chainId'), reply(1, CHAIN_HEX));
    await t.settleHeadReads(page);
    expect(t.isKnown(EP)).toBe(true);
    expect(t.observedPageChain.get(EP)).toBe(CHAIN_ID);
    exchange(page, EP, call(2, 'eth_chainId'), reply(2, '0x1'));
    await t.settleHeadReads(page);
    expect(t.observedPageChain.get(EP)).toBe(CHAIN_ID_CONFLICT);
    expect(t.isForeign(EP)).toBe(true);
    expect(t.isKnown(EP)).toBe(false);
  });

  it('treats one batch answering two chains as the same contradiction', async () => {
    const { t, page } = watched();
    exchange(
      page,
      EP,
      [call(1, 'eth_chainId'), call(2, 'eth_chainId')],
      [reply(1, CHAIN_HEX), reply(2, '0x1')],
    );
    await t.settleHeadReads(page);
    expect(t.observedPageChain.get(EP)).toBe(CHAIN_ID_CONFLICT);
    expect(t.isForeign(EP)).toBe(true);
    expect(t.diamondKeysOf(page).has(EP)).toBe(false);
  });

  it('admits on the expected chain id alone, with no address evidence', async () => {
    const { t, page } = watched();
    exchange(page, EP, call(1, 'eth_chainId'), reply(1, CHAIN_HEX));
    exchange(page, EP, call(2, 'eth_blockNumber'), reply(2, '0x64'));
    await t.settleHeadReads(page);
    expect(t.isKnown(EP)).toBe(true);
    expect(t.pageHeadOf(page)).toBe(100n);
  });
});

describe('settleHeadReads drains the parses in flight', () => {
  it('waits for a reply still being parsed, and the sample then sees it', async () => {
    const { t, page } = watched();
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    let release;
    const req = request(EP, call(2, 'eth_blockNumber'));
    page.emit('request', req);
    page.emit('response', {
      request: () => req,
      url: () => EP,
      json: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    expect(t.pageHeadOf(page), 'sampled before the parse finished').toBe(0n);
    const drained = t.settleHeadReads(page);
    release(reply(2, '0x64'));
    expect(await drained).toBe(true);
    expect(t.pageHeadOf(page)).toBe(100n);
  });

  it('returns true at once when nothing is in flight', async () => {
    const { t, page } = watched();
    expect(await t.settleHeadReads(page)).toBe(true);
  });

  it('reports false when the set never reaches quiet within the budget', async () => {
    // Each reply's parse lands the next reply, the way a polling page keeps
    // the set from ever emptying. Bounded, and it says the bound was hit.
    //
    // Queued as a microtask rather than emitted inline: inline, the next
    // response's handler starts INSIDE this parse and recurses without end;
    // a microtask lands it after this parse returns and before the drain's
    // own continuation runs, which is the "arrived while the await settled"
    // timing the bounded loop exists for.
    const { t, page } = watched();
    let n = 0;
    const emitNext = () => {
      // Far past the drain's budget, and finite: an endless microtask chain
      // would starve the event loop after the assertion has already passed.
      if (n >= 40) return;
      n += 1;
      const id = n;
      const req = request(EP, call(id, 'eth_blockNumber'));
      page.emit('response', {
        request: () => req,
        url: () => EP,
        json: async () => {
          queueMicrotask(emitNext);
          return reply(id, '0x64');
        },
      });
    };
    emitNext();
    expect(await t.settleHeadReads(page)).toBe(false);
    expect(n).toBeGreaterThan(6);
  });
});

describe('floorEstablishedFor — an answer must precede the first ask, per endpoint', () => {
  it('holds when the endpoint announced a head before its first eth_call was sent', async () => {
    const { t, page } = watched();
    exchange(page, EP, call(1, 'eth_blockNumber'), reply(1, '0x64'));
    await t.settleHeadReads(page);
    exchange(page, EP, diamondRead(2), reply(2, '0x'));
    await t.settleHeadReads(page);
    expect(t.floorEstablishedFor(page, new Set())).toBe(true);
  });

  it('fails when the read was asked first — nothing seen bounds that read', async () => {
    const { t, page } = watched();
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    exchange(page, EP, call(2, 'eth_blockNumber'), reply(2, '0x64'));
    await t.settleHeadReads(page);
    expect(t.floorEstablishedFor(page, new Set())).toBe(false);
  });

  it('accepts the read-first endpoint when the drive sampled it before navigation', async () => {
    const { t, page } = watched();
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    exchange(page, EP, call(2, 'eth_blockNumber'), reply(2, '0x64'));
    await t.settleHeadReads(page);
    expect(t.floorEstablishedFor(page, new Set([EP]))).toBe(true);
  });

  it('fails when no proven endpoint announced a head at all', async () => {
    const { t, page } = watched();
    exchange(page, EP, call(1, 'eth_chainId'), reply(1, CHAIN_HEX));
    await t.settleHeadReads(page);
    expect(t.floorEstablishedFor(page, new Set())).toBe(false);
  });

  it('requires EVERY proven endpoint to be bounded, not one of them', async () => {
    const { t, page } = watched();
    exchange(page, EP, call(1, 'eth_blockNumber'), reply(1, '0x64'));
    await t.settleHeadReads(page);
    exchange(page, EP, diamondRead(2), reply(2, '0x'));
    // The second endpoint reads before it ever announces.
    exchange(page, EP2, diamondRead(1), reply(1, '0x'));
    exchange(page, EP2, call(2, 'eth_blockNumber'), reply(2, '0x64'));
    await t.settleHeadReads(page);
    expect(t.floorEstablishedFor(page, new Set())).toBe(false);
    expect(t.floorEstablishedFor(page, new Set([EP2]))).toBe(true);
  });

  it('is false for a page never watched', () => {
    const t = build();
    expect(t.floorEstablishedFor(new FakePage(), new Set([EP]))).toBe(false);
  });
});

describe('the direct probes', () => {
  async function knownFromFirstPage(fetch) {
    const t = build({ fetch });
    const first = new FakePage();
    t.watchPageHead(first);
    exchange(first, EP, diamondRead(1), reply(1, '0x'));
    exchange(first, EP2, diamondRead(1), reply(1, '0x'));
    await t.settleHeadReads(first);
    return t;
  }

  it('pageProviderHead takes the LOWEST over the endpoints earlier pages proved', async () => {
    const calls = [];
    const t = await knownFromFirstPage(
      fetchAnswering({ [EP]: reply(1, '0x80'), [EP2]: reply(1, '0x70') }, calls),
    );
    const sample = await t.pageProviderHead();
    expect(sample.head).toBe(112n);
    expect([...sample.sampled].sort()).toEqual([EP, EP2].sort());
    expect(calls.sort()).toEqual([EP, EP2].sort());
  });

  it('pageProviderHead refuses replies the page would not have acted on', async () => {
    for (const [label, bad] of [
      ['result beside an error', { jsonrpc: '2.0', id: 1, result: '0x80', error: { code: 1 } }],
      ['a batch it never sent', [reply(1, '0x80')]],
      ['a decimal quantity', reply(1, '128')],
      ['an HTTP error', 'http-error'],
    ]) {
      const t = await knownFromFirstPage(fetchAnswering({ [EP]: bad, [EP2]: bad }));
      const sample = await t.pageProviderHead();
      expect(sample.head, label).toBeNull();
      expect(sample.sampled.size, label).toBe(0);
    }
  });

  it('pageProviderHead answers from the endpoints that did reply, naming them', async () => {
    const t = await knownFromFirstPage(fetchAnswering({ [EP]: reply(1, '0x80') }));
    const sample = await t.pageProviderHead();
    expect(sample.head).toBe(128n);
    expect([...sample.sampled]).toEqual([EP]);
  });

  it('pageProviderHead asks nothing of an endpoint proven foreign since', async () => {
    const calls = [];
    const t = await knownFromFirstPage(fetchAnswering({ [EP]: reply(1, '0x80') }, calls));
    const later = new FakePage();
    t.watchPageHead(later);
    exchange(later, EP2, call(1, 'eth_chainId'), reply(1, '0x1'));
    await t.settleHeadReads(later);
    const sample = await t.pageProviderHead();
    expect(sample.head).toBe(128n);
    expect(calls).toEqual([EP]);
  });

  it('pageProviderCeiling takes the HIGHEST over the endpoints THIS page used', async () => {
    const calls = [];
    const t = build({
      fetch: fetchAnswering({ [EP]: reply(1, '0x80'), [EP2]: reply(1, '0x90') }, calls),
    });
    const page = new FakePage();
    t.watchPageHead(page);
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    exchange(page, EP2, diamondRead(1), reply(1, '0x'));
    await t.settleHeadReads(page);
    const ceiling = await t.pageProviderCeiling(page);
    expect(ceiling.head).toBe(144n);
    expect([...ceiling.sampled].sort()).toEqual([EP, EP2].sort());
    expect(calls.sort()).toEqual([EP, EP2].sort());
  });

  it('pageProviderCeiling leaves an endpoint that will not answer out of `sampled`', async () => {
    const t = build({ fetch: fetchAnswering({ [EP]: reply(1, '0x80') }) });
    const page = new FakePage();
    t.watchPageHead(page);
    exchange(page, EP, diamondRead(1), reply(1, '0x'));
    exchange(page, EP2, diamondRead(1), reply(1, '0x'));
    await t.settleHeadReads(page);
    const ceiling = await t.pageProviderCeiling(page);
    expect(ceiling.head).toBe(128n);
    expect([...ceiling.sampled]).toEqual([EP]);
    // So the drive's gate — every key sampled or foreign — refuses it.
    const bounded = [...t.diamondKeysOf(page)].every(
      (k) => ceiling.sampled.has(k) || t.isForeign(k),
    );
    expect(bounded).toBe(false);
  });

  it('pageProviderCeiling is empty for a page that proved no endpoint', async () => {
    const t = build();
    const page = new FakePage();
    t.watchPageHead(page);
    const ceiling = await t.pageProviderCeiling(page);
    expect(ceiling.head).toBe(0n);
    expect(ceiling.sampled.size).toBe(0);
  });
});
