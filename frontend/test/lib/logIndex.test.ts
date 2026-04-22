import { describe, it, expect, beforeEach, vi } from 'vitest';
import { id as keccakId } from 'ethers';

// Force CHUNK=10 regardless of what `.env.local` sets for VITE_LOG_INDEX_CHUNK.
// The module reads this at import time, so stub before the dynamic import.
vi.stubEnv('VITE_LOG_INDEX_CHUNK', '10');
const { loadLoanIndex, _resetLogIndexCache } = await import('../../src/lib/logIndex');

const LOAN_INITIATED_TOPIC0 = keccakId('LoanInitiated(uint256,uint256,address,address)');
const TRANSFER_TOPIC0 = keccakId('Transfer(address,address,uint256)');

/**
 * Exercises the caching + incremental-scan behavior of `loadLoanIndex`
 * without any real network. The Contract mock records call args so the
 * test asserts paging math, cache reuse, and Transfer-derived ownership.
 */

interface FakeProvider {
  getBlockNumber: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
}

interface FakeContract {
  runner: { provider: FakeProvider };
  queryFilter: ReturnType<typeof vi.fn>;
}

const DIAMOND = '0x1234567890abcdef1234567890abcdef12345678';
const CHAIN = 11155111;
// Full 20-byte addresses so the topic-slicing path in logIndex recovers
// them unmodified. Tests compare against the lowercased form.
const ALICE = '0x00000000000000000000000000000000000A11CE';
const BOB = '0x0000000000000000000000000000000000000B0B';
const CAROL = '0x000000000000000000000000000000000000CAd0';

function mkContract(head: number): FakeContract {
  const provider: FakeProvider = {
    getBlockNumber: vi.fn().mockResolvedValue(head),
    getLogs: vi.fn().mockResolvedValue([]),
  };
  return {
    runner: { provider },
    queryFilter: vi.fn().mockResolvedValue([]),
  };
}

function loanRow(loanId: bigint, lender = '0xa', borrower = '0xb') {
  const pad = (v: string) => '0x' + v.replace(/^0x/, '').padStart(64, '0').toLowerCase();
  const loanHex = pad('0x' + loanId.toString(16));
  const lenderPadded = pad(lender);
  // Encode non-indexed `borrower` into `data` (32-byte ABI-encoded address).
  const data = pad(borrower);
  return {
    topics: [LOAN_INITIATED_TOPIC0, loanHex, pad('0x0'), lenderPadded],
    data,
  };
}

function transferRow(tokenId: bigint, to: string, from = '0x0000000000000000000000000000000000000000') {
  const pad = (v: string) => '0x' + v.replace(/^0x/, '').padStart(64, '0').toLowerCase();
  const tokenHex = pad('0x' + tokenId.toString(16));
  return {
    topics: [TRANSFER_TOPIC0, pad(from), pad(to), tokenHex],
  };
}

/**
 * Drive the queryFilter mock with per-event arrays — the implementation
 * runs `LoanInitiated` then `Transfer` for each chunk, so we answer in
 * that alternating order.
 */
function answer(
  contract: FakeContract,
  chunks: Array<{ loans: ReturnType<typeof loanRow>[]; transfers: ReturnType<typeof transferRow>[] }>,
) {
  const loans = chunks.map((c) => c.loans);
  const transfers = chunks.map((c) => c.transfers);
  contract.runner.provider.getLogs.mockImplementation((filter: { topics?: string[] }) => {
    const t0 = filter?.topics?.[0];
    if (t0 === LOAN_INITIATED_TOPIC0) return Promise.resolve(loans.shift() ?? []);
    if (t0 === TRANSFER_TOPIC0) return Promise.resolve(transfers.shift() ?? []);
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  _resetLogIndexCache(CHAIN, DIAMOND);
});

describe('loadLoanIndex', () => {
  it('scans from deployBlock to head and returns decoded rows', async () => {
    // Head=5 stays within a single CHUNK=10 window — one getLogs per stream.
    const diamond = mkContract(5);
    const LENDER = '0x000000000000000000000000000000000000000a';
    const BORROWER = '0x000000000000000000000000000000000000000b';
    answer(diamond, [
      { loans: [loanRow(1n, LENDER, BORROWER), loanRow(2n, LENDER, BORROWER)], transfers: [] },
    ]);

    const { loans } = await loadLoanIndex(diamond as any, DIAMOND, 0, CHAIN);

    expect(loans).toEqual([
      { loanId: 1n, lender: LENDER.toLowerCase(), borrower: BORROWER.toLowerCase() },
      { loanId: 2n, lender: LENDER.toLowerCase(), borrower: BORROWER.toLowerCase() },
    ]);
    expect(diamond.runner.provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ topics: [LOAN_INITIATED_TOPIC0], fromBlock: 0, toBlock: 5 }),
    );
    expect(diamond.runner.provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ topics: [TRANSFER_TOPIC0], fromBlock: 0, toBlock: 5 }),
    );
  });

  it('builds an owner lookup from Transfer events', async () => {
    const diamond = mkContract(10);
    answer(diamond, [
      {
        loans: [loanRow(1n)],
        transfers: [
          transferRow(1n, ALICE), // mint
          transferRow(2n, BOB),
          transferRow(1n, CAROL), // secondary move — latest wins
        ],
      },
    ]);

    const { getOwner } = await loadLoanIndex(diamond as any, DIAMOND, 0, CHAIN);
    expect(getOwner(1n)).toBe(CAROL.toLowerCase());
    expect(getOwner(2n)).toBe(BOB.toLowerCase());
    // Unseen token returns null, letting callers fall back to `ownerOf`.
    expect(getOwner(99n)).toBeNull();
  });

  it('treats burn (transfer to zero) as no-owner', async () => {
    const diamond = mkContract(10);
    answer(diamond, [
      {
        loans: [],
        transfers: [
          transferRow(1n, ALICE),
          transferRow(1n, '0x0000000000000000000000000000000000000000', ALICE),
        ],
      },
    ]);
    const { getOwner } = await loadLoanIndex(diamond as any, DIAMOND, 0, CHAIN);
    expect(getOwner(1n)).toBeNull();
  });

  it('dedupes across scans and merges cached rows', async () => {
    // Use tiny heads (8, then 25) so the scan stays within the CHUNK=10
    // default and produces exactly one call per event stream.
    const first = mkContract(8);
    answer(first, [{ loans: [loanRow(1n)], transfers: [transferRow(1n, ALICE)] }]);
    await loadLoanIndex(first as any, DIAMOND, 0, CHAIN);

    const second = mkContract(15);
    answer(second, [{ loans: [loanRow(2n), loanRow(1n)], transfers: [transferRow(2n, BOB)] }]);
    const { loans, getOwner } = await loadLoanIndex(second as any, DIAMOND, 0, CHAIN);

    // Second scan resumes from block 9 (lastBlock + 1) up to the new head.
    expect(second.runner.provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ topics: [LOAN_INITIATED_TOPIC0], fromBlock: 9, toBlock: 15 }),
    );
    expect(second.runner.provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ topics: [TRANSFER_TOPIC0], fromBlock: 9, toBlock: 15 }),
    );
    expect(loans.map((r) => r.loanId)).toEqual([1n, 2n]);
    // Cached owner from the first scan survives.
    expect(getOwner(1n)).toBe(ALICE.toLowerCase());
    expect(getOwner(2n)).toBe(BOB.toLowerCase());
  });

  it('no-ops when cache already covers the head', async () => {
    const first = mkContract(10);
    answer(first, [{ loans: [loanRow(1n)], transfers: [transferRow(1n, ALICE)] }]);
    await loadLoanIndex(first as any, DIAMOND, 0, CHAIN);

    const second = mkContract(10);
    const { loans, getOwner } = await loadLoanIndex(second as any, DIAMOND, 0, CHAIN);

    expect(second.runner.provider.getLogs).not.toHaveBeenCalled();
    expect(loans.map((r) => r.loanId)).toEqual([1n]);
    expect(getOwner(1n)).toBe(ALICE.toLowerCase());
  });

  it('paginates scans that exceed the CHUNK block size', async () => {
    // CHUNK defaults to 10. Head=25 → chunks [0..9], [10..19], [20..25]
    // × 5 event streams (LoanInitiated, Transfer, OfferCreated,
    // OfferAccepted, OfferCanceled) = 15 calls.
    const diamond = mkContract(25);
    await loadLoanIndex(diamond as any, DIAMOND, 0, CHAIN);

    expect(diamond.runner.provider.getLogs).toHaveBeenCalledTimes(15);
    expect(diamond.runner.provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ topics: [LOAN_INITIATED_TOPIC0], fromBlock: 0, toBlock: 9 }),
    );
    expect(diamond.runner.provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ topics: [LOAN_INITIATED_TOPIC0], fromBlock: 20, toBlock: 25 }),
    );
    expect(diamond.runner.provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ topics: [TRANSFER_TOPIC0], fromBlock: 0, toBlock: 9 }),
    );
  });
});
