/**
 * The `acceptedAsTranslated` policy shape and the two questions asked
 * of it — shared, for the reason `stillEnglish.ts` is shared.
 *
 * `check-locale-coverage.ts` consults the policy to decide whether a
 * value that reads as English is nevertheless correct.
 * `check-baselines-shrink-only.ts` has to consult the SAME policy to
 * decide whether removing a baseline pair is authorized: recognising a
 * backlog entry as a legitimate identical translation means moving it
 * into the policy AND deleting it from the baseline, and the removal
 * check would otherwise reject that — the value still reads as English,
 * which is precisely why it needed a policy entry (Codex #1607 r25).
 *
 * Without this the two guards deadlock: coverage passes, the required
 * shrink-only check fails, and there is no supported way to correct a
 * false-positive backlog entry.
 */

export interface AcceptedAsTranslatedEntry {

  reason: string;
  /** The English value this exemption was granted against. If en.json
   *  moves on, the exemption is stale rather than silently inherited. */
  source: string;
  /**
   * The locales it applies to — REQUIRED, never an implicit "all".
   *
   * Equality can be right in one language and wrong in the next.
   * `copy.consentParts.suffix` is `.` in English, `.` in Arabic, and
   * `。` in Chinese: a key-wide exemption would excuse Chinese
   * regressing to the ASCII period, and no exemption leaves Arabic as
   * permanent debt it does not owe. Neither is acceptable, and only a
   * per-locale scope avoids both (Codex #1607 r2).
   */
  locales: string[];
  /**
   * The exact accepted value, per locale, where it is NOT the English
   * one. Defaults to `source`.
   *
   * The comparison asks whether everything the reader sees can be built
   * out of the English source's own words — so a translation made of
   * those words is flagged however it arranges them, which is necessary,
   * because a rearranged English sentence still reads as English.
   * French `Mode strict` for `Strict mode` is the case where that is
   * wrong, and no rule can tell it from `content to Skip` without
   * knowing French. Recording the accepted value makes the
   * judgement explicit AND self-expiring: reword the French and it no
   * longer matches, so the scope reports as unused rather than
   * standing guard over a string nobody looked at again.
   */
  values?: Record<string, string>;
  /**
   * This value may never differ, in ANY translated locale.
   *
   * Two kinds of entry live in this scope and they behave oppositely
   * when the locale value moves. `Mode strict` is a judgement about the
   * present: reword the French and the entry should retire, so the
   * guard says "narrow the locale list". A brand name is not — change
   * `Vaipakam` to `VaipakamX` and the guard said the same thing, and
   * FOLLOWING that advice made the corrupted brand pass (Codex #1607
   * r20). The advice was right for one kind of entry and actively
   * harmful for the other.
   *
   * An invariant entry is checked against every translated locale
   * rather than its own `locales` list, so narrowing the scope cannot
   * make a changed value green. The only ways out are restoring the
   * value or deleting this flag — a one-line edit, on a line that says
   * it must never change, in front of a reviewer.
   */
  invariant?: boolean;
}

/** The exact value this exemption accepts for `code`. */
export const acceptedValue = (entry: AcceptedAsTranslatedEntry, code: string): string =>
  entry.values?.[code] ?? entry.source;

/**
 * Does the policy authorize this exact value for this locale?
 *
 * EXACT, never normalized. The exemption is granted against one string:
 * a normalized match is not that string, and Spanish `vaipakam` for the
 * brand would otherwise ride in on the entry granted for `Vaipakam`
 * (Codex #1607 r4).
 */
export function isAcceptedAsTranslated(
  policy: Readonly<Record<string, AcceptedAsTranslatedEntry>>,
  key: string,
  code: string,
  value: unknown,
): boolean {
  const entry = policy[key];
  if (entry === undefined || !entry.locales.includes(code)) return false;
  return value === acceptedValue(entry, code);
}
