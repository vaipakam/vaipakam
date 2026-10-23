/**
 * #1848 — the sale listing's own record, read into two three-valued
 * verdicts. An unread record answers neither question.
 */
import { describe, expect, it } from "vitest";
import {
  saleListingCardView,
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

const card = (over: Partial<LoanSalePendingState>): LoanSalePendingState => ({
  listed: true,
  loanActive: true,
  isHolder: true,
  offerId: "5",
  offerIdVerifyFailed: false,
  expiresAt: 2_000n,
  accepted: false,
  fillable: "yes",
  completable: "yes",
  cancelUnlocked: true,
  ...over,
});

describe("saleListingCardView", () => {
  it("states each answered record", () => {
    expect(saleListingCardView(card({}), false)).toBe("open");
    expect(
      saleListingCardView(
        card({ accepted: true, fillable: "no", completable: "yes" }),
        false,
      ),
    ).toBe("accepted");
    expect(
      saleListingCardView(card({ fillable: "no", completable: "no" }), false),
    ).toBe("expired");
    expect(
      saleListingCardView(
        card({ loanActive: false, fillable: "no", completable: "no" }),
        false,
      ),
    ).toBe("settled");
  });

  it("says nothing it did not read when the record was not read", () => {
    expect(
      saleListingCardView(
        card({
          expiresAt: null,
          accepted: null,
          fillable: "unknown",
          completable: "unknown",
        }),
        false,
      ),
    ).toBe("unread");
  });

  it("makes no record claim from a stale answer, whatever it said", () => {
    for (const over of [
      {},
      { accepted: true, fillable: "no" as const },
      { fillable: "no" as const, completable: "no" as const },
      { loanActive: false, fillable: "no" as const, completable: "no" as const },
    ]) {
      expect(saleListingCardView(card(over), true)).toBe("stale");
    }
  });
});
