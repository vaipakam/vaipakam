/**
 * #2523 — the offset acceptance review. Which verdict blocks signing, in
 * which order, and that the reader builds each verdict from the right party
 * and the right reads, driven with a fake client.
 */
import { describe, expect, it } from "vitest";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  type PublicClient,
} from "viem";
import { DIAMOND_ABI_VIEM } from "@vaipakam/contracts/abis";
import {
  offsetReviewBlock,
  offsetReviewFingerprint,
  readOffsetReviewLive,
  type OffsetReview,
} from "./offsetAcceptReview";

const DIAMOND = "0x00000000000000000000000000000000000000dd" as const;
const ASSET = "0x00000000000000000000000000000000000000a1" as const;
const POSTER = "0x00000000000000000000000000000000000000b0" as const;
const OTHER = "0x00000000000000000000000000000000000000c0" as const;

const DAY = 86_400n;
const START = 1_000_000n;
const NOW = START + 10n * DAY;
const PRINCIPAL = 1_000n * 10n ** 18n;

const loanDetails = (over: Record<string, unknown> = {}) => ({
  status: 0,
  lender: OTHER,
  borrower: POSTER,
  borrowerTokenId: 7n,
  principal: PRINCIPAL,
  principalAsset: ASSET,
  interestRateBps: 1_000n,
  startTime: START,
  durationDays: 30n,
  interestAccrualStart: 0n,
  interestRemainingDays: 0,
  useFullTermInterest: false,
  allowsPartialRepay: true,
  periodicInterestCadence: 0,
  interestSettled: 0n,
  collateralAsset: ASSET,
  collateralAssetType: 0,
  collateralAmount: 1n,
  collateralTokenId: 0n,
  collateralQuantity: 0n,
  prepayAsset: ASSET,
  ...over,
});

const noCommit = () =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: DIAMOND_ABI_VIEM,
      functionName: "getIntentCommit",
      data: encodeErrorResult({
        abi: DIAMOND_ABI_VIEM,
        errorName: "IntentNoCommit",
        args: [1n],
      }),
    }),
    { abi: DIAMOND_ABI_VIEM, functionName: "getIntentCommit", args: [1n] },
  );

interface Setup {
  loan?: Record<string, unknown>;
  offer?: Record<string, unknown>;
  holder?: `0x${string}` | "burned";
  allowance?: bigint;
  balance?: bigint;
  intent?: "none" | "live" | "fail";
}

/** A fake client that records which address each ERC-20 read asked about. */
function client(setup: Setup, asked: string[] = []): PublicClient {
  return {
    getBlock: async () => ({ number: 5n, timestamp: NOW }),
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args?: readonly unknown[];
    }) => {
      switch (functionName) {
        case "getOfferDetails":
          return {
            creator: POSTER,
            offerType: 0,
            durationDays: 15n,
            ...setup.offer,
          };
        case "getLoanDetails":
          return loanDetails(setup.loan);
        case "sellerForfeitureWindow":
          return [START, 0n];
        case "ownerOf":
          asked.push("ownerOf");
          if (setup.holder === "burned") throw new Error("ERC721NonexistentToken");
          return setup.holder ?? POSTER;
        case "allowance":
          asked.push(`allowance:${String(args?.[0])}`);
          return setup.allowance ?? 10n ** 30n;
        case "balanceOf":
          asked.push(`balanceOf:${String(args?.[0])}`);
          return setup.balance ?? 10n ** 30n;
        case "getIntentCommit":
          if (setup.intent === "live") return {};
          if (setup.intent === "fail") throw new Error("rpc down");
          throw noCommit();
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

const read = (setup: Setup, asked?: string[]) =>
  readOffsetReviewLive(client(setup, asked), DIAMOND, "9", "3");

describe("readOffsetReviewLive", () => {
  it("clears an offset whose every condition holds, funded by the poster", async () => {
    const asked: string[] = [];
    const r = await read({}, asked);
    expect(r.kind).toBe("offset");
    expect(offsetReviewBlock(r)).toBeNull();
    // The close-out pulls from the POSTER, so that is whose funding is read.
    expect(asked).toEqual([
      "ownerOf",
      `allowance:${POSTER}`,
      `balanceOf:${POSTER}`,
    ]);
  });

  it("is not an offset when the offer is not a lender offer", async () => {
    const r = await read({ offer: { offerType: 1 } });
    expect(r).toEqual({ kind: "other" });
    expect(offsetReviewBlock(r)).toBe("not-offset");
  });

  it("is not an offset when the creator is not the loan’s current borrower", async () => {
    expect(await read({ holder: OTHER })).toEqual({ kind: "other" });
  });

  it("blocks when the earlier loan is no longer active", async () => {
    const r = await read({ loan: { status: 1 } });
    expect(offsetReviewBlock(r)).toBe("loan-not-active");
  });

  it("decides an ended loan from its status alone, even once the borrower NFT is burned", async () => {
    // Codex #2675 r1 — a borrower who claimed before cancelling the offset
    // has burned the NFT the shape check reads; the known answer must not
    // turn into a failed read.
    const asked: string[] = [];
    const r = await read({ loan: { status: 1 }, holder: "burned" }, asked);
    expect(r.kind).toBe("loan-ended");
    expect(offsetReviewBlock(r)).toBe("loan-not-active");
    expect(asked).toEqual([]);
  });

  it("measures the term from the loan snapshot’s own block time", async () => {
    // 20 days remain (30-day loan, 10 days in): 20 days fits exactly, 21 not.
    expect(
      offsetReviewBlock(await read({ offer: { durationDays: 20n } })),
    ).toBeNull();
    expect(
      offsetReviewBlock(await read({ offer: { durationDays: 21n } })),
    ).toBe("term-passed");
  });

  it("blocks on a stored swap-to-repay order, and on an unread answer", async () => {
    expect(offsetReviewBlock(await read({ intent: "live" }))).toBe(
      "swap-order",
    );
    expect(offsetReviewBlock(await read({ intent: "fail" }))).toBe(
      "swap-order-unknown",
    );
  });

  it("blocks when the poster’s approval or balance is below the close-out bound", async () => {
    expect(offsetReviewBlock(await read({ allowance: PRINCIPAL }))).toBe(
      "poster-not-covered",
    );
    expect(offsetReviewBlock(await read({ balance: PRINCIPAL }))).toBe(
      "poster-not-covered",
    );
  });
});

describe("offsetReviewBlock order", () => {
  it("names the most structural reason first", async () => {
    const r = await read({
      loan: { status: 1 },
      offer: { durationDays: 25n },
      intent: "live",
      allowance: 0n,
    });
    expect(offsetReviewBlock(r)).toBe("loan-not-active");
  });
});

describe("offsetReviewFingerprint", () => {
  it("moves with every input to the verdict and is distinct when unread", async () => {
    const base = await read({});
    const prints = new Set([
      offsetReviewFingerprint(undefined),
      offsetReviewFingerprint({ kind: "other" } as OffsetReview),
      offsetReviewFingerprint(base),
      offsetReviewFingerprint(await read({ loan: { status: 1 } })),
      offsetReviewFingerprint(await read({ offer: { durationDays: 25n } })),
      offsetReviewFingerprint(await read({ intent: "live" })),
      offsetReviewFingerprint(await read({ allowance: 0n })),
    ]);
    expect(prints.size).toBe(7);
    expect(offsetReviewFingerprint(await read({}))).toBe(
      offsetReviewFingerprint(base),
    );
  });
});
