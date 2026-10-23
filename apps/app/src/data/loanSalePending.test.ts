/**
 * #1848 — the sale listing's own record, read into two three-valued
 * verdicts. An unread record answers neither question.
 */
import { describe, expect, it } from "vitest";
import {
  saleFundingWatch,
  saleListingVerdicts,
  type LoanSalePendingState,
} from "./loanSalePending";

const open = { expiresAt: 2_000n, accepted: false };

describe("saleListingVerdicts", () => {
  it("says unknown, not yes or no, when the record was not read", () => {
    expect(
      saleListingVerdicts({ loanActive: true, record: null, chainNow: 1_000n }),
    ).toEqual({
      fillable: "unknown",
      completable: "unknown",
    });
  });

  it("is open to buyers before the expiry", () => {
    expect(
      saleListingVerdicts({ loanActive: true, record: open, chainNow: 1_999n }),
    ).toEqual({
      fillable: "yes",
      completable: "yes",
    });
  });

  it("is closed from the expiry itself, as the accept path judges it", () => {
    expect(
      saleListingVerdicts({ loanActive: true, record: open, chainNow: 2_000n }),
    ).toEqual({
      fillable: "no",
      completable: "no",
    });
  });

  it("can still complete once accepted, though no further buyer can take it", () => {
    expect(
      saleListingVerdicts({
        loanActive: true,
        record: { expiresAt: 2_000n, accepted: true },
        chainNow: 3_000n,
      }),
    ).toEqual({ fillable: "no", completable: "yes" });
  });

  it("can never complete on a loan that is no longer active, read or not", () => {
    for (const record of [open, null]) {
      expect(
        saleListingVerdicts({ loanActive: false, record, chainNow: 1_000n }),
      ).toEqual({
        fillable: "no",
        completable: "no",
      });
    }
  });

  it("treats a zero expiry as never expiring", () => {
    expect(
      saleListingVerdicts({
        loanActive: true,
        record: { expiresAt: 0n, accepted: false },
        chainNow: 10_000n,
      }),
    ).toEqual({ fillable: "yes", completable: "yes" });
  });
});

const watched = (over: Partial<LoanSalePendingState>): LoanSalePendingState => ({
  listed: true,
  loanActive: true,
  isHolder: true,
  offerId: "5",
  offerIdVerifyFailed: false,
  saleRateBps: 500n,
  expiresAt: 2_000n,
  accepted: false,
  fillable: "yes",
  completable: "yes",
  cancelUnlocked: true,
  requiredNow: 10n,
  requiredBound: 20n,
  fundingKnown: true,
  allowanceShort: true,
  balanceShort: true,
  ...over,
});

describe("saleFundingWatch", () => {
  it("shows the shortfalls while the sale can still complete", () => {
    expect(saleFundingWatch(watched({}), false)).toEqual({
      unknown: false,
      allowanceShort: true,
      balanceShort: true,
    });
  });

  it("silences every funding line, the unknown warning included, once an answered verdict says no", () => {
    expect(
      saleFundingWatch(
        watched({ fillable: "no", completable: "no", fundingKnown: false }),
        false,
      ),
    ).toEqual({ unknown: false, allowanceShort: false, balanceShort: false });
  });

  it("never lets a stale 'no' silence a warning", () => {
    expect(
      saleFundingWatch(watched({ fillable: "no", completable: "no" }), true),
    ).toEqual({ unknown: false, allowanceShort: true, balanceShort: true });
    expect(
      saleFundingWatch(
        watched({
          completable: "no",
          fundingKnown: false,
          allowanceShort: false,
          balanceShort: false,
        }),
        true,
      ).unknown,
    ).toBe(true);
  });

  it("shows nothing to a wallet that does not hold the position", () => {
    expect(saleFundingWatch(watched({ isHolder: false }), false)).toEqual({
      unknown: false,
      allowanceShort: false,
      balanceShort: false,
    });
  });
});
