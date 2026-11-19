import { describe, expect, it } from "vitest";
import { checkForWhom } from "./borrowFor";

const ME = "0x00000000000000000000000000000000000000aa" as const;

describe("borrow for someone: the address check", () => {
  it("takes an address and gives it back checksummed", () => {
    const r = checkForWhom(" 0x52908400098527886e0f7030069857d2e4169ee7 ", ME);
    expect(r).toEqual({
      ok: true,
      address: "0x52908400098527886E0F7030069857D2E4169EE7",
    });
  });
  it("refuses empty, malformed, zero and the borrower themself", () => {
    expect(checkForWhom("", ME)).toEqual({ ok: false, why: "empty" });
    expect(checkForWhom("0x12", ME)).toEqual({ ok: false, why: "invalid" });
    expect(
      checkForWhom("0x0000000000000000000000000000000000000000", ME),
    ).toEqual({ ok: false, why: "zero" });
    expect(checkForWhom(ME.toUpperCase().replace("0X", "0x"), ME)).toEqual({
      ok: false,
      why: "self",
    });
  });
});
