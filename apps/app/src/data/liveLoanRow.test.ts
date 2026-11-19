import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { CHAIN_CLOCK_UNREAD, withChainDeadlines } from "./liveLoanRow";
import type { IndexedLoan } from "./indexer";

const DIAMOND = "0x00000000000000000000000000000000000000dd" as const;
const DAY = 86_400;
const START = 1_000_000;
const NOW = START + 40 * DAY;

const row = (over: Partial<IndexedLoan> = {}): IndexedLoan =>
  ({
    loanId: 1,
    status: "active",
    startTime: START,
    durationDays: 30,
    ...over,
  }) as IndexedLoan;

interface Chain {
  pauses?: { start: bigint; end: bigint; pausedBefore: bigint }[];
  fails?: boolean;
  /** #3525 — the Diamond's outage window, or a failing read. */
  outage?: readonly [bigint, bigint] | "fails";
}

function client(chain: Chain, reads: string[] = []): PublicClient {
  return {
    getBlock: async () => ({ number: 9n, timestamp: BigInt(NOW) }),
    readContract: async ({
      functionName,
      blockNumber,
    }: {
      functionName: string;
      blockNumber?: bigint;
    }) => {
      reads.push(`${functionName}@${String(blockNumber)}`);
      if (chain.fails) throw new Error("rpc down");
      if (functionName === "getPauseIntervals") {
        return [chain.pauses ?? [], BigInt(chain.pauses?.length ?? 0)];
      }
      if (functionName === "getGraceBuckets") return [];
      if (functionName === "getSequencerOutageWindow") {
        if (chain.outage === "fails") throw new Error("rpc down");
        return chain.outage ?? [0n, 0n];
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe("withChainDeadlines (#2808)", () => {
  it("dates an active row on the loan clock, all reads at one block", async () => {
    const reads: string[] = [];
    const pauses = [
      {
        start: BigInt(START + 5 * DAY),
        end: BigInt(START + 7 * DAY),
        pausedBefore: 0n,
      },
    ];
    const [r] = await withChainDeadlines(client({ pauses }, reads), DIAMOND, [
      row(),
    ]);
    expect(r.deadlines).toEqual({
      available: true,
      originalMaturity: START + 30 * DAY,
      pauseCredit: 2 * DAY,
      maturity: START + 32 * DAY,
      // 30 days of duration takes the default 3-day grace.
      graceEnd: START + 35 * DAY,
      pauseInForce: false,
      graceEndMovedByOutage: false,
      sequencerOutage: { downAt: 0, windowEnd: 0, readAt: NOW },
      asOf: NOW,
    });
    expect(reads.sort()).toEqual([
      "getGraceBuckets@9",
      "getPauseIntervals@9",
      "getSequencerOutageWindow@9",
    ]);
  });

  it("moves a grace end inside the outage window, and says when the window did not read (#3525)", async () => {
    const graceEnd = BigInt(START + 35 * DAY);
    const pauses = [{ start: BigInt(START + 5 * DAY), end: BigInt(START + 7 * DAY), pausedBefore: 0n }];
    const [moved] = await withChainDeadlines(
      client({ pauses, outage: [graceEnd - 10n, graceEnd + 3_600n] }),
      DIAMOND,
      [row()],
    );
    expect(moved.deadlines).toMatchObject({ graceEnd: START + 35 * DAY + 3_600, graceEndMovedByOutage: true });
    const [unknown] = await withChainDeadlines(client({ pauses, outage: "fails" }), DIAMOND, [row()]);
    expect(unknown.deadlines).toMatchObject({
      available: true,
      graceEnd: START + 35 * DAY,
      sequencerOutage: null,
      sequencerOutageUnknown: "unread",
    });
  });

  it("says a pause in force is still moving the dates", async () => {
    const pauses = [
      { start: BigInt(NOW - DAY), end: 2n ** 64n - 1n, pausedBefore: 0n },
    ];
    const [r] = await withChainDeadlines(client({ pauses }), DIAMOND, [row()]);
    expect(r.deadlines).toMatchObject({
      available: true,
      pauseInForce: true,
      pauseCredit: DAY,
    });
  });

  it("states unknown, never the original date, when the clock does not read", async () => {
    const [r] = await withChainDeadlines(client({ fails: true }), DIAMOND, [
      row(),
    ]);
    expect(r.deadlines).toEqual({
      available: false,
      reason: CHAIN_CLOCK_UNREAD,
    });
  });

  it("leaves rows that are not active alone, and reads nothing for them", async () => {
    const reads: string[] = [];
    const rows = [row({ status: "repaid" })];
    expect(await withChainDeadlines(client({}, reads), DIAMOND, rows)).toEqual(
      rows,
    );
    expect(reads).toEqual([]);
  });
});
