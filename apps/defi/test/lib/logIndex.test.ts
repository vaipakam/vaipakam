import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { keccak256, toBytes } from 'viem';
// #1076: defi migrated off ethers to viem — ethers.id(sig) == keccak256(utf8Bytes(sig)).
const keccakId = (sig: string) => keccak256(toBytes(sig));

// Force CHUNK=10 regardless of what `.env.local` sets for VITE_LOG_INDEX_CHUNK.
// The module reads this at import time, so stub before the dynamic import.
vi.stubEnv('VITE_LOG_INDEX_CHUNK', '10');
const { loadLoanIndex, _resetLogIndexCache } = await import('../../src/lib/logIndex');

// #1076: `logIndex` no longer takes an ethers Contract with a
// `runner.provider` + `queryFilter`. It takes an **rpcUrl string** and does
// raw JSON-RPC over the global `fetch` (see the `jsonRpcCall` doc-block in
// src/lib/logIndex.ts). It also ORs every event topic0 into a single bulk
// `eth_getLogs` per chunk (plus two small secondary calls for
// OfferConsumedBySale + SwapToRepay), instead of one queryFilter per event
// stream — so the old "one getLogs per LoanInitiated / Transfer stream,
// 15 calls for head=25" model is stale. We drive it by stubbing `fetch`:
//   - eth_getBlockByNumber(['safe', …]) → the scan's upper-bound head
//   - eth_getLogs → logs whose topic0 is in the request's OR-list and whose
//     block falls in [fromBlock, toBlock]
// The LoanInitiated signature also changed to the 6-arg form the contract
// actually emits; the old 4-arg topic0 matched nothing.
const LOAN_INITIATED_TOPIC0 = keccakId(
  'LoanInitiated(uint256,uint256,address,address,uint256,uint256)',
);
const TRANSFER_TOPIC0 = keccakId('Transfer(address,address,uint256)');

const RPC_URL = 'http://localhost:8545';
const DIAMOND = '0x1234567890abcdef1234567890abcdef12345678';
// #1076: use the local chainId (31337). The current source throws
// `chain config not resolved` for `deployBlock <= 0` on any NON-local
// chain (a genesis-scan RPC-hammer guard); 31337 is exempted and clamps
// an unresolved deployBlock to genesis, so `deployBlock = 0` still scans
// from block 0 — which is exactly what these window assertions expect.
const CHAIN = 31337;
// Full 20-byte addresses so the topic-slicing path in logIndex recovers
// them unmodified. Tests compare against the lowercased form.
const ALICE = '0x00000000000000000000000000000000000A11CE';
const BOB = '0x0000000000000000000000000000000000000B0B';
const CAROL = '0x000000000000000000000000000000000000CAd0';
const ZERO = '0x0000000000000000000000000000000000000000';

interface RawLogLite {
  block: number;
  topics: string[];
  data: string;
}

let logCounter = 0;
/** 32-byte word from a hex value, right-aligned + zero-padded (mirrors the
 *  ABI word encoding the source decoder reads). */
const word = (v: string) => v.replace(/^0x/, '').padStart(64, '0').toLowerCase();
const topicWord = (v: string) => '0x' + word(v);

function loanRow(
  loanId: bigint,
  lender = '0xa',
  borrower = '0xb',
  block = 1,
): RawLogLite {
  return {
    block,
    // topics: [topic0, loanId, offerId(=0), lender]. All three are indexed.
    topics: [
      LOAN_INITIATED_TOPIC0,
      topicWord('0x' + loanId.toString(16)),
      topicWord('0x0'),
      topicWord(lender),
    ],
    // data: (address borrower, uint256 principal, uint256 collateralAmount)
    data: '0x' + word(borrower) + word('0') + word('0'),
  };
}

function transferRow(tokenId: bigint, to: string, from = ZERO, block = 1): RawLogLite {
  return {
    block,
    // ERC-721 Transfer(from, to, tokenId) — all three indexed.
    topics: [TRANSFER_TOPIC0, topicWord(from), topicWord(to), topicWord('0x' + tokenId.toString(16))],
    data: '0x',
  };
}

/** Recorded eth_getLogs invocations (parsed windows + OR'd topic0 list). */
let getLogsCalls: Array<{ from: number; to: number; topic0s: string[] }> = [];

function jsonResp(result: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  };
}

/** Install a `fetch` stub that answers eth_getBlockByNumber (safe head) and
 *  eth_getLogs (topic0 + block-range filtered) for the given log set. */
function installFetch(head: number, logs: RawLogLite[]) {
  getLogsCalls = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as {
      method: string;
      params: unknown[];
    };
    if (method === 'eth_getBlockByNumber') {
      return jsonResp({ number: '0x' + head.toString(16) });
    }
    if (method === 'eth_blockNumber') {
      return jsonResp('0x' + head.toString(16));
    }
    if (method === 'eth_getLogs') {
      const f = params[0] as {
        fromBlock?: string;
        toBlock?: string;
        topics?: (string | string[])[];
      };
      const from = f.fromBlock ? parseInt(f.fromBlock, 16) : 0;
      const to = f.toBlock ? parseInt(f.toBlock, 16) : head;
      const topic0s = (Array.isArray(f.topics?.[0]) ? f.topics![0] : []) as string[];
      const allowed = new Set(topic0s.map((t) => t.toLowerCase()));
      getLogsCalls.push({ from, to, topic0s });
      const matched = logs
        .filter(
          (l) =>
            l.block >= from &&
            l.block <= to &&
            allowed.has(l.topics[0].toLowerCase()),
        )
        .map((l) => {
          logCounter += 1;
          return {
            blockNumber: '0x' + l.block.toString(16),
            blockHash: '0x' + '0'.repeat(64),
            transactionHash: '0x' + logCounter.toString(16).padStart(64, '0'),
            transactionIndex: '0x0',
            logIndex: '0x' + logCounter.toString(16),
            address: DIAMOND,
            data: l.data,
            topics: l.topics,
            removed: false,
          };
        });
      return jsonResp(matched);
    }
    return jsonResp(null);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Bulk-call windows — the ones whose OR-list carries the LoanInitiated
 *  topic0 (i.e. the main per-chunk scan, not the secondary sale/swap calls). */
function bulkCalls() {
  return getLogsCalls.filter((c) =>
    c.topic0s.map((t) => t.toLowerCase()).includes(LOAN_INITIATED_TOPIC0.toLowerCase()),
  );
}

beforeEach(() => {
  _resetLogIndexCache(CHAIN, DIAMOND);
  logCounter = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadLoanIndex', () => {
  it('scans from deployBlock to head and returns decoded rows', async () => {
    // Head=5 stays within a single CHUNK=10 window — one bulk getLogs.
    const LENDER = '0x000000000000000000000000000000000000000a';
    const BORROWER = '0x000000000000000000000000000000000000000b';
    installFetch(5, [
      loanRow(1n, LENDER, BORROWER),
      loanRow(2n, LENDER, BORROWER),
    ]);

    const { loans } = await loadLoanIndex(RPC_URL, DIAMOND, 0, CHAIN);

    expect(loans).toEqual([
      { loanId: 1n, lender: LENDER.toLowerCase(), borrower: BORROWER.toLowerCase() },
      { loanId: 2n, lender: LENDER.toLowerCase(), borrower: BORROWER.toLowerCase() },
    ]);
    // #1076: LoanInitiated + Transfer are OR'd into ONE bulk getLogs per
    // chunk now, so we assert the bulk window (0..5) instead of a
    // per-topic filter shape.
    expect(bulkCalls().some((c) => c.from === 0 && c.to === 5)).toBe(true);
  });

  it('builds an owner lookup from Transfer events', async () => {
    installFetch(10, [
      loanRow(1n),
      transferRow(1n, ALICE), // mint
      transferRow(2n, BOB),
      transferRow(1n, CAROL), // secondary move — latest wins
    ]);

    const { getOwner } = await loadLoanIndex(RPC_URL, DIAMOND, 0, CHAIN);
    expect(getOwner(1n)).toBe(CAROL.toLowerCase());
    expect(getOwner(2n)).toBe(BOB.toLowerCase());
    // Unseen token returns null, letting callers fall back to `ownerOf`.
    expect(getOwner(99n)).toBeNull();
  });

  it('treats burn (transfer to zero) as no-owner', async () => {
    installFetch(10, [
      transferRow(1n, ALICE),
      transferRow(1n, ZERO, ALICE), // burn
    ]);
    const { getOwner } = await loadLoanIndex(RPC_URL, DIAMOND, 0, CHAIN);
    expect(getOwner(1n)).toBeNull();
  });

  it('dedupes across scans and merges cached rows', async () => {
    // Use tiny heads (8, then 15) so the scan stays within the CHUNK=10
    // default and produces exactly one bulk call per scan.
    installFetch(8, [loanRow(1n), transferRow(1n, ALICE)]);
    await loadLoanIndex(RPC_URL, DIAMOND, 0, CHAIN);

    // Second scan resumes from block 9 (lastBlock + 1); place its logs there.
    installFetch(15, [
      loanRow(2n, '0xa', '0xb', 10),
      loanRow(1n, '0xa', '0xb', 10),
      transferRow(2n, BOB, ZERO, 10),
    ]);
    const { loans, getOwner } = await loadLoanIndex(RPC_URL, DIAMOND, 0, CHAIN);

    expect(bulkCalls().some((c) => c.from === 9 && c.to === 15)).toBe(true);
    expect(loans.map((r) => r.loanId)).toEqual([1n, 2n]);
    // Cached owner from the first scan survives.
    expect(getOwner(1n)).toBe(ALICE.toLowerCase());
    expect(getOwner(2n)).toBe(BOB.toLowerCase());
  });

  it('no-ops when cache already covers the head', async () => {
    installFetch(10, [loanRow(1n), transferRow(1n, ALICE)]);
    await loadLoanIndex(RPC_URL, DIAMOND, 0, CHAIN);

    installFetch(10, []);
    const { loans, getOwner } = await loadLoanIndex(RPC_URL, DIAMOND, 0, CHAIN);

    // fromBlock (lastBlock+1=11) > head (10) → early return, no getLogs at all.
    expect(getLogsCalls).toHaveLength(0);
    expect(loans.map((r) => r.loanId)).toEqual([1n]);
    expect(getOwner(1n)).toBe(ALICE.toLowerCase());
  });

  it('paginates scans that exceed the CHUNK block size', async () => {
    // CHUNK=10. Head=25 → bulk chunks [0..9], [10..19], [20..25] = 3 bulk
    // calls. (Old model asserted 15 separate per-event calls — stale.)
    installFetch(25, []);
    await loadLoanIndex(RPC_URL, DIAMOND, 0, CHAIN);

    const bulk = bulkCalls();
    expect(bulk).toHaveLength(3);
    expect(bulk.some((c) => c.from === 0 && c.to === 9)).toBe(true);
    expect(bulk.some((c) => c.from === 10 && c.to === 19)).toBe(true);
    expect(bulk.some((c) => c.from === 20 && c.to === 25)).toBe(true);
  });
});
