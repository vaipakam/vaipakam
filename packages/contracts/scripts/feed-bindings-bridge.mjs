/**
 * Bridge provenance for the feed-bindings drafting tool
 * (`chainlink-feed-bindings.mjs`, step 3b).
 *
 * WHY. The three list sources (two aggregators and a token list) each map a
 * symbol to an address, so they can all repeat one mistake. On a rollup or
 * sidechain most tokens are bridged from Ethereum, and the canonical bridge
 * records on chain which token on this chain stands for an Ethereum token.
 * Reading that, and requiring the Ethereum token to be the one Ethereum's
 * own bindings file already settled, proves a token's identity from the
 * chains rather than from a list.
 *
 * WHAT THE PROOF IS, per chain:
 *   - Arbitrum: the L2 gateway router's `calculateL2TokenAddress(l1Token)`.
 *     It names the one token its gateway mints for that Ethereum token, and
 *     the proof counts only when that address holds code (the gateway has
 *     deployed it).
 *   - Polygon PoS: the child chain manager's `rootToChildToken(l1Token)`, a
 *     mapping only the bridge's governance sets.
 *   - Base and Optimism (OP Stack): a bridged token can say anything about
 *     itself, so its own report is not used. The proof is the standard
 *     bridge's ledger on Ethereum: `deposits(l1Token, l2Token)` is how much
 *     of the Ethereum token the bridge holds for each token on this chain.
 *     The candidate that holds MORE THAN HALF of the bridge's whole balance
 *     of the Ethereum token is the canonical one; at most one can.
 *
 * HOW IT IS USED. It is evidence BESIDE the three sources, never instead of
 * them:
 *   - A drafted binding (all three sources agree) whose token the proof
 *     confirms gains `bridge` in `agreedBy` and its `bridgeProof`.
 *   - A drafted binding whose token the proof contradicts (the bridge names a
 *     different, deployed token for the same Ethereum original) goes to
 *     review: two tokens claim the symbol, which is a call for a person.
 *   - A review entry is settled into a binding only when the proof names an
 *     address, at least two sources name that address, and every source that
 *     names anything names it. So a source that only omits the token no longer
 *     blocks a binding, while a source naming another token still does.
 *   - Without a proof (no settled Ethereum original, an ambiguous one, or a
 *     token the bridge does not carry, such as a natively issued stablecoin),
 *     nothing changes.
 *
 * The decision functions here are pure; the reads take a viem client and a
 * pinned block, like the tool's own step 4.
 */
import { getAddress, isAddress, parseAbi, zeroAddress } from 'viem';

/** The canonical bridge per chain slug. Addresses are mainnet only. */
export const BRIDGES = Object.freeze({
  arbitrum: {
    method: 'arbitrum-gateway-router',
    // L2GatewayRouter on Arbitrum One.
    contract: '0x5288c571Fd7aD117beA99bF60FE0846C4E84F933',
  },
  polygon: {
    method: 'polygon-child-chain-manager',
    // ChildChainManager (proxy) on Polygon PoS.
    contract: '0xA6FA4fB5f76172d178d61B04b0ecd319C5d1C0aa',
  },
  base: {
    method: 'op-standard-bridge-deposits',
    // L1StandardBridge (proxy) on Ethereum for Base.
    l1Bridge: '0x3154Cf16ccdb4C6d922629664174b904d80F2C35',
  },
  optimism: {
    method: 'op-standard-bridge-deposits',
    // L1StandardBridge (proxy) on Ethereum for OP Mainnet.
    l1Bridge: '0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1',
  },
});

/** The OP Stack's predeployed L2StandardBridge, every L1 bridge's `OTHER_BRIDGE()`. */
export const OP_L2_STANDARD_BRIDGE = '0x4200000000000000000000000000000000000010';

const SOURCES = ['coingecko', 'coinmarketcap', 'tokenList'];
const lower = (s) => String(s).toLowerCase();

// ---------------------------------------------------------------- originals

/**
 * The settled Ethereum token per symbol, from Ethereum's bindings file: its
 * drafted `bindings` and hand-written `manual` entries, never its `review`.
 * A symbol bound to two different tokens there has no original (it is listed
 * in `ambiguous`), so nothing on another chain is proved against it. Pure.
 */
export function ethereumOriginals(ethFile) {
  const seen = new Map();
  const add = (symbol, token) => {
    if (!symbol || !isAddress(token ?? '')) return;
    const s = lower(symbol);
    if (!seen.has(s)) seen.set(s, new Set());
    seen.get(s).add(getAddress(token));
  };
  for (const b of ethFile.bindings ?? []) add(b.symbol, b.token);
  for (const m of ethFile.manual ?? []) add(String(m.pair ?? '').split(' / ')[0], m.token);
  const originals = new Map();
  const ambiguous = [];
  for (const [s, tokens] of seen) {
    if (tokens.size === 1) originals.set(s, [...tokens][0]);
    else ambiguous.push(s);
  }
  return { originals, ambiguous: ambiguous.sort() };
}

// ---------------------------------------------------------------- decisions

/**
 * Decides one REVIEW entry against its proof. `candidates` is the entry's
 * per-source answer (arrays of addresses); `canonical` is the address the
 * bridge names, or null. A source agrees only when the bridge's token is the
 * ONLY address it names: a source that also names another address leaves the
 * token's identity open, and the bridge never decides between two candidates
 * a list offers. So it settles only when at least two sources name the
 * bridge's token and no source names any other. Returns `{ settle: true,
 * token, agreedBy }` or `{ settle: false, why }`. Pure.
 */
export function settleReview(candidates, canonical) {
  if (!canonical) return { settle: false, why: 'the bridge names no token for the Ethereum original' };
  const c = lower(canonical);
  const naming = SOURCES.filter((k) => (candidates[k] ?? []).length > 0);
  const others = (k) => candidates[k].filter((a) => lower(a) !== c);
  const dissenting = naming.filter((k) => others(k).length > 0);
  if (dissenting.length > 0) {
    const named = [...new Set(dissenting.flatMap(others).map((a) => getAddress(a)))];
    return {
      settle: false,
      why: `the bridge names ${getAddress(canonical)}, but ${dissenting.join(' and ')} ${dissenting.length > 1 ? 'name' : 'names'} another token: ${named.join(', ')}`,
    };
  }
  const agreeing = naming;
  if (agreeing.length < 2) {
    return { settle: false, why: `the bridge names ${getAddress(canonical)}, but only ${agreeing.join(', ') || 'no source'} names it` };
  }
  return { settle: true, token: getAddress(canonical), agreedBy: [...agreeing, 'bridge'] };
}

/**
 * Applies the proofs to one chain's resolved bindings and review entries.
 *
 * - `resolved`: `{ bindings, review }` from the tool's `resolveBindings`.
 * - `keptByPath`: directoryPath → the kept feed (base symbol, decimals,
 *   heartbeat, category), for the entries a proof settles.
 * - `proofs`: lower-case symbol → `{ l1Token, canonical, detail }`.
 * - `tokenDecimals(symbol, address)`: the token list's decimals, or undefined.
 * - `quotes`: quote symbol → the registry's quote address (the tool's `QUOTES`).
 * - `manualCovered`: a Set of `token|quote` keys a manual entry covers.
 *
 * Returns `{ bindings, review, skipped, settled }`, where `settled` lists the
 * directory paths a proof turned into bindings. A settled binding may share a
 * (token, quote) with another; the caller separates those as it does for
 * every draft. Pure.
 */
export function applyBridgeProofs({ resolved, keptByPath, proofs, tokenDecimals, quotes, manualCovered = new Set() }) {
  const bindings = [];
  const review = [];
  const skipped = [];
  const settled = [];
  const proofOf = (symbol) => proofs.get(lower(symbol));
  const evidence = (p) => ({ method: p.method, l1Token: p.l1Token, canonical: p.canonical, detail: p.detail });

  for (const b of resolved.bindings) {
    const p = proofOf(b.symbol);
    if (!p) {
      bindings.push(b);
      continue;
    }
    if (p.canonical && lower(p.canonical) === lower(b.token)) {
      bindings.push({ ...b, agreedBy: [...b.agreedBy, 'bridge'], bridgeProof: evidence(p) });
    } else if (p.canonical) {
      review.push({
        pair: b.pair,
        directoryPath: b.directoryPath,
        feed: b.feed,
        quote: b.quote,
        reason: `the three sources name ${b.token}, but the canonical bridge maps the Ethereum ${b.symbol} to ${p.canonical}: two tokens claim the symbol`,
        candidates: { token: [b.token], bridge: [p.canonical] },
        bridgeProof: evidence(p),
      });
    } else {
      bindings.push({ ...b, bridgeProof: evidence(p) });
    }
  }

  for (const r of resolved.review) {
    const f = keptByPath.get(r.directoryPath);
    const p = f ? proofOf(f.base) : undefined;
    // Only an entry the three sources sent here can be settled; a duplicate
    // (token, quote) or a failed read is not a question of identity.
    const fromSources = r.candidates && SOURCES.some((k) => k in r.candidates);
    if (!f || !p || !fromSources) {
      review.push(r);
      continue;
    }
    const d = settleReview(r.candidates, p.canonical);
    if (!d.settle) {
      review.push({ ...r, bridgeProof: { ...evidence(p), outcome: d.why } });
      continue;
    }
    if (manualCovered.has(`${lower(d.token)}|${f.quote}`)) {
      skipped.push({ pair: f.pair, directoryPath: f.directoryPath, reason: 'a manual entry covers this token and quote' });
      continue;
    }
    settled.push(f.directoryPath);
    bindings.push({
      token: d.token,
      symbol: f.base,
      tokenDecimals: tokenDecimals(f.base, d.token),
      quote: f.quote,
      quoteAddress: quotes[f.quote],
      feed: f.feed,
      feedDecimals: f.feedDecimals,
      pair: f.pair,
      heartbeat: f.heartbeat,
      category: f.category,
      directoryPath: f.directoryPath,
      agreedBy: d.agreedBy,
      bridgeProof: evidence(p),
      settledFrom: r.reason,
    });
  }
  return { bindings, review, skipped, settled };
}

// ---------------------------------------------------------------- reads

const ARB_ROUTER_ABI = parseAbi(['function calculateL2TokenAddress(address) view returns (address)']);
const POLYGON_CCM_ABI = parseAbi(['function rootToChildToken(address) view returns (address)']);
const OP_L1_BRIDGE_ABI = parseAbi([
  'function deposits(address, address) view returns (uint256)',
  'function OTHER_BRIDGE() view returns (address)',
]);
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);

/**
 * The OP Stack decision: the candidate holding more than half of the L1
 * bridge's balance of the Ethereum token, or null. `deposits` maps a
 * lower-case candidate to its recorded deposit. Pure.
 */
export function depositMajority(balance, deposits) {
  if (!(balance > 0n)) return { canonical: null, detail: 'the bridge holds none of the Ethereum token' };
  for (const [cand, amount] of deposits) {
    if (amount * 2n > balance) {
      const bps = (amount * 10_000n) / balance;
      return { canonical: getAddress(cand), detail: `holds ${bps} bps of the standard bridge's balance of the Ethereum token` };
    }
  }
  return { canonical: null, detail: 'no candidate holds a majority of the standard bridge\'s balance of the Ethereum token' };
}

/**
 * Reads the proof for every symbol in `wanted` (lower-case symbol →
 * `{ l1Token, candidates: Set<lower-case address> }`).
 *
 * - `l2` / `l2Block`: the chain's client and the block the tool pins.
 * - `l1` / `l1Block`: an Ethereum client and block (OP Stack chains only).
 *
 * Returns the proofs Map and what was read, for the file's `bridge` record.
 */
export async function readBridgeProofs({ slug, l2, l2Block, l1, l1Block, wanted, multicallAddress }) {
  const bridge = BRIDGES[slug];
  if (!bridge) throw new Error(`no canonical bridge is configured for ${slug}`);
  const entries = [...wanted.entries()];
  const proofs = new Map();
  if (entries.length === 0) {
    return {
      proofs,
      record: bridge.l1Bridge
        ? { method: bridge.method, l1Bridge: bridge.l1Bridge, l1CheckedAtBlock: Number(l1Block) }
        : { method: bridge.method, contract: bridge.contract, checkedAtBlock: Number(l2Block) },
    };
  }
  const call = (client, blockNumber, contracts) =>
    client.multicall({ contracts, blockNumber, allowFailure: true, multicallAddress, batchSize: 16_384 });

  if (bridge.method === 'arbitrum-gateway-router' || bridge.method === 'polygon-child-chain-manager') {
    const arb = bridge.method === 'arbitrum-gateway-router';
    const results = await call(
      l2,
      l2Block,
      entries.map(([, w]) => ({
        address: bridge.contract,
        abi: arb ? ARB_ROUTER_ABI : POLYGON_CCM_ABI,
        functionName: arb ? 'calculateL2TokenAddress' : 'rootToChildToken',
        args: [w.l1Token],
      })),
    );
    // The router computes an address even for a token never bridged, so the
    // proof counts only where a token answers there at the same block (a call
    // to an address with no code returns nothing, and the read fails).
    const named = results.map((r) => (r.status === 'success' && r.result !== zeroAddress ? r.result : null));
    const toProbe = named.filter(Boolean);
    const live = toProbe.length
      ? await call(l2, l2Block, toProbe.map((address) => ({ address, abi: ERC20_ABI, functionName: 'decimals' })))
      : [];
    let k = 0;
    for (const [i, [sym, w]] of entries.entries()) {
      const r = results[i];
      let canonical = null;
      let detail;
      if (r.status !== 'success') detail = `${arb ? 'calculateL2TokenAddress' : 'rootToChildToken'}() reverted`;
      else if (!named[i]) detail = 'the bridge maps the Ethereum token to nothing';
      else if (live[k++].status !== 'success') {
        detail = `the bridge's address for the Ethereum token, ${getAddress(named[i])}, holds no token`;
      } else {
        canonical = getAddress(named[i]);
        detail = arb ? "the gateway router's token for the Ethereum original" : "the child chain manager's token for the Ethereum original";
      }
      proofs.set(sym, { method: bridge.method, l1Token: w.l1Token, canonical, detail });
    }
    return { proofs, record: { method: bridge.method, contract: bridge.contract, checkedAtBlock: Number(l2Block) } };
  }

  // OP Stack: the L1 standard bridge's deposit ledger.
  const [other] = await call(l1, l1Block, [{ address: bridge.l1Bridge, abi: OP_L1_BRIDGE_ABI, functionName: 'OTHER_BRIDGE' }]);
  if (other.status !== 'success' || lower(other.result) !== lower(OP_L2_STANDARD_BRIDGE)) {
    throw new Error(`${bridge.l1Bridge} on Ethereum is not an OP Stack L1 standard bridge (OTHER_BRIDGE() did not answer ${OP_L2_STANDARD_BRIDGE})`);
  }
  const plan = [];
  const contracts = [];
  for (const [sym, w] of entries) {
    const cands = [...w.candidates].sort();
    plan.push({ sym, w, cands, at: contracts.length });
    contracts.push({ address: w.l1Token, abi: ERC20_ABI, functionName: 'balanceOf', args: [bridge.l1Bridge] });
    for (const c of cands) contracts.push({ address: bridge.l1Bridge, abi: OP_L1_BRIDGE_ABI, functionName: 'deposits', args: [w.l1Token, c] });
  }
  const results = await call(l1, l1Block, contracts);
  for (const { sym, w, cands, at } of plan) {
    const bal = results[at];
    const deps = cands.map((c, j) => [c, results[at + 1 + j]]);
    let p;
    if (bal.status !== 'success' || deps.some(([, r]) => r.status !== 'success')) {
      p = { canonical: null, detail: 'a deposit-ledger read reverted' };
    } else {
      p = depositMajority(bal.result, new Map(deps.map(([c, r]) => [c, r.result])));
    }
    proofs.set(sym, { method: bridge.method, l1Token: w.l1Token, ...p });
  }
  return { proofs, record: { method: bridge.method, l1Bridge: bridge.l1Bridge, l1CheckedAtBlock: Number(l1Block) } };
}

/**
 * Collects, per symbol with a settled Ethereum original, the candidate
 * addresses the sources gave on this chain (the OP Stack proof checks each).
 * Pure.
 */
export function wantedProofs({ resolved, keptByPath, originals }) {
  const wanted = new Map();
  const add = (symbol, addrs) => {
    const s = lower(symbol);
    const l1Token = originals.get(s);
    if (!l1Token) return;
    if (!wanted.has(s)) wanted.set(s, { l1Token, candidates: new Set() });
    for (const a of addrs) if (isAddress(a ?? '')) wanted.get(s).candidates.add(lower(a));
  };
  for (const b of resolved.bindings) add(b.symbol, [b.token, ...Object.values(b.otherCandidates ?? {}).flat()]);
  for (const r of resolved.review) {
    const f = keptByPath.get(r.directoryPath);
    if (f && r.candidates) add(f.base, Object.values(r.candidates).flat());
  }
  return wanted;
}
