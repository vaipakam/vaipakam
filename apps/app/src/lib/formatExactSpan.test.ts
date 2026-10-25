import { describe, expect, it } from "vitest";
import { daysRemaining, formatExactSpan } from "./format";

describe("formatExactSpan (#2808)", () => {
  it("states the span in days, hours and minutes, zero parts left out", () => {
    expect(formatExactSpan(2 * 86_400 + 3 * 3_600)).toBe("2 days 3 hours");
    expect(formatExactSpan(86_400 + 60)).toBe("1 day 1 minute");
    expect(formatExactSpan(45 * 60)).toBe("45 minutes");
  });

  it("never rounds up", () => {
    // Two hours is not "1 day", and 59 seconds is not "1 minute".
    expect(formatExactSpan(2 * 3_600)).toBe("2 hours");
    expect(formatExactSpan(2 * 86_400 + 59)).toBe("2 days");
    expect(formatExactSpan(59)).toBe("under a minute");
  });
});

describe("daysRemaining", () => {
  it("counts whole days to the date it is given, negative once past", () => {
    const now = Date.now() / 1000;
    expect(daysRemaining(now + 3 * 86_400 + 100)).toBe(3);
    expect(daysRemaining(now - 10)).toBe(-1);
  });
});
