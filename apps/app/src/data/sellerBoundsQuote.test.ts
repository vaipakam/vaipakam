/**
 * #1810 — the seller-bound quote the listing form shows and binds the listing
 * to. The figures themselves are the chain's; what is tested here is the two
 * adjustments that keep the reviewed floor one a listing can actually meet.
 */
import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import {
  QUOTE_CONFIRM_ALLOWANCE_SECONDS,
  QUOTE_ROUNDING_MARGIN,
  quoteExpiryFor,
  readSellerBoundsQuote,
  reviewedFloor,
} from "./sellerBoundsQuote";

describe("quoteExpiryFor", () => {
  it("quotes the window plus the confirmation allowance", () => {
    expect(quoteExpiryFor(1_000n, 86_400n, 10_000_000n)).toBe(
      1_000n + 86_400n + QUOTE_CONFIRM_ALLOWANCE_SECONDS,
    );
  });

  it("clamps at the loan due date, as the listing does", () => {
    expect(quoteExpiryFor(1_000n, 86_400n, 50_000n)).toBe(50_000n);
  });
});

describe("reviewedFloor", () => {
  it("lowers the quoted floor by the rounding margin", () => {
    expect(reviewedFloor(1_000n)).toBe(1_000n - QUOTE_ROUNDING_MARGIN);
  });

  it("never goes below zero", () => {
    expect(reviewedFloor(1n)).toBe(0n);
    expect(reviewedFloor(0n)).toBe(0n);
  });
});

describe("readSellerBoundsQuote", () => {
  it("reads the quote at the block it took the time from, for the allowed expiry", async () => {
    const calls: { args: readonly unknown[]; blockNumber?: bigint }[] = [];
    const client = {
      getBlock: async () => ({ timestamp: 5_000n, number: 77n }),
      readContract: async (req: {
        args: readonly unknown[];
        blockNumber?: bigint;
      }) => {
        calls.push({ args: req.args, blockNumber: req.blockNumber });
        return [900n, 40n] as const;
      },
    } as unknown as PublicClient;
    const quote = await readSellerBoundsQuote(
      client,
      "0x0000000000000000000000000000000000000001",
      {
        loanId: 3,
        saleRateBps: 500n,
        listingSeconds: 3_600n,
        maturity: 1_000_000n,
      },
    );
    expect(calls).toEqual([
      {
        args: [3n, 500n, 5_000n + 3_600n + QUOTE_CONFIRM_ALLOWANCE_SECONDS],
        blockNumber: 77n,
      },
    ]);
    expect(quote).toEqual({
      minSellerNet: 900n - QUOTE_ROUNDING_MARGIN,
      maxHeld: 40n,
      quotedExpiry: 5_000n + 3_600n + QUOTE_CONFIRM_ALLOWANCE_SECONDS,
      quotedAt: 5_000n,
    });
  });
});
