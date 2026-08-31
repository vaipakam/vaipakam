/**
 * The report redaction contract (#2024).
 *
 * `apps/app`'s report builder states it in its own header — "wallet address is
 * SHORTENED to 0x1234…abcd — the full address never leaves the device via a
 * report" — and the published Privacy Policy repeats it to users. Until this
 * file existed, nothing tested it: `redactText` and `redactCap` had no unit
 * coverage at all, which is how a percent-encoded address passed the scrubber
 * unnoticed.
 *
 * The suite lives beside the implementation in `@vaipakam/lib` because the
 * contract binds TWO surfaces — the connected app's report builder and
 * `apps/agent`'s support-ticket endpoint, which re-scrubs because it trusts
 * no client. One suite covers both; a second copy would drift.
 *
 * The cases below are written against the CONTRACT rather than the
 * implementation: what must never survive into a report, and what must
 * survive intact. A redactor that mangles a transaction hash is a different
 * defect from one that leaks an address, and both would be regressions.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_MAPPED_INPUT,
  redactAddress,
  redactCap,
  redactText,
} from './redactAddresses';

const ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const SHORT = '0x1234…5678';

/** Percent-encode every character, the strongest form of the #2024 case. */
const pctAll = (s: string): string =>
  [...s].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');

describe('redactText — plain addresses', () => {
  it('shortens an address anywhere in the text', () => {
    expect(redactText(`crash at ${ADDR} while loading`)).toBe(
      `crash at ${SHORT} while loading`,
    );
  });

  it('shortens an uppercase 0X prefix too', () => {
    expect(redactText(ADDR.replace('0x', '0X'))).toBe('0X1234…5678');
  });

  it('shortens every occurrence, not just the first', () => {
    expect(redactText(`${ADDR} and ${ADDR}`)).toBe(`${SHORT} and ${SHORT}`);
  });

  it('leaves a 32-byte transaction hash intact', () => {
    // The negative lookahead exists for this: support needs hashes whole,
    // and a mangled prefix would neither redact nor preserve anything.
    const hash = `0x${'a'.repeat(64)}`;
    expect(redactText(hash)).toBe(hash);
  });

  it('leaves ordinary text alone', () => {
    expect(redactText('no addresses here, 0x12 is too short')).toBe(
      'no addresses here, 0x12 is too short',
    );
  });
});

describe('redactText — percent-encoded addresses (#2024)', () => {
  it('shortens a fully percent-encoded address', () => {
    const out = redactText(`/offers?wallet=${pctAll(ADDR)}`);
    expect(out).toBe(`/offers?wallet=${SHORT}`);
  });

  it('shortens a partially encoded address', () => {
    // Only the `0x` escaped — enough to defeat a literal-only matcher.
    const partial = `%30%78${ADDR.slice(2)}`;
    expect(redactText(`?w=${partial}`)).toBe(`?w=${SHORT}`);
  });

  it('leaves the surrounding text spelled exactly as it was', () => {
    // The decode is for SEARCHING only. A reader still needs the rest of
    // the URL as it actually appeared, escapes included.
    const out = redactText(`/a%20b?wallet=${pctAll(ADDR)}&next=%2Fhome`);
    expect(out).toBe(`/a%20b?wallet=${SHORT}&next=%2Fhome`);
  });

  it('handles an encoded and a plain address in one string', () => {
    const out = redactText(`plain ${ADDR} encoded ${pctAll(ADDR)}`);
    expect(out).toBe(`plain ${SHORT} encoded ${SHORT}`);
  });

  it('does not decode a percent-encoded transaction hash into a false match', () => {
    const hash = `0x${'b'.repeat(64)}`;
    expect(redactText(pctAll(hash))).toBe(pctAll(hash));
  });
});

describe('redactText — nested encoding (#2024 Codex r1)', () => {
  // A single decode pass leaves `%2530%2578…` looking like `%30%78…` — still
  // encoded, still matching nothing — and the recipient recovers the address
  // with a second decode. Double-encoding is what happens to a URL carried
  // inside another URL's query parameter, so this is ordinary, not exotic.
  it('shortens a twice-encoded address', () => {
    expect(redactText(`?w=${pctAll(pctAll(ADDR))}`)).toBe(`?w=${SHORT}`);
  });

  it('shortens a three-times-encoded address', () => {
    expect(redactText(pctAll(pctAll(pctAll(ADDR))))).toBe(SHORT);
  });

  it('shortens a mixed-depth pair, emitting each exactly once', () => {
    // Two addresses encoded to DIFFERENT depths in one string, both literal
    // at the fixpoint and therefore both found in a single scan.
    //
    // This case has carried two wrong claims in as many rounds, so it is
    // worth being precise about what it does NOT show. It does not pin span
    // collapsing: the search runs only at the fixpoint, `matchAll` yields
    // disjoint matches over one string, and there is consequently no overlap
    // arithmetic left to exercise (Codex r3 P3 — the guard was removed rather
    // than left as untestable defence).
    const out = redactText(`a=${pctAll(ADDR)}&b=${pctAll(pctAll(ADDR))}`);
    expect(out).toBe(`a=${SHORT}&b=${SHORT}`);
    expect(out.match(/…/g)).toHaveLength(2);
  });

  it('emits a single shortening for a twice-encoded address', () => {
    const out = redactText(pctAll(pctAll(ADDR)));
    expect(out).toBe(SHORT);
  });

  it('leaves a twice-encoded tx hash intact', () => {
    const hash = `0x${'c'.repeat(64)}`;
    const twice = pctAll(pctAll(hash));
    expect(redactText(twice)).toBe(twice);
  });

  it('terminates on deeply nested input without throwing', () => {
    let s = ADDR;
    for (let i = 0; i < 6; i++) s = pctAll(s);
    expect(() => redactText(s)).not.toThrow();
  });

  // Codex r2 P1. Encoding EVERY character triples the length each level, so a
  // depth cap looked generous. Encoding only the two `%` signs grows it by
  // four characters per level, so nine levels fit in 78 characters and outlast
  // any fixed depth. The loop runs to a fixpoint under a work budget instead.
  const pctPercents = (s: string): string => s.replaceAll('%', '%25');

  it('shortens a nine-level selectively-encoded address', () => {
    let s = `%30%78${ADDR.slice(2)}`;
    for (let i = 0; i < 8; i++) s = pctPercents(s);
    expect(s.length).toBeLessThan(200);
    expect(redactText(s)).toBe(SHORT);
  });

  it('shortens a twenty-level selectively-encoded address', () => {
    let s = `%30%78${ADDR.slice(2)}`;
    for (let i = 0; i < 20; i++) s = pctPercents(s);
    expect(redactText(s)).toBe(SHORT);
  });
});

describe('redactText — fails closed rather than guessing (#2024 Codex r2)', () => {
  const pctPercentsN = (s: string, n: number): string => {
    let out = s;
    for (let i = 0; i < n; i++) out = out.replaceAll('%', '%25');
    return out;
  };

  it('drops unresolved escape runs when the work budget is exhausted', () => {
    // Selective encoding costs one PASS per level while adding only four
    // characters, so deep enough nesting outruns a budget proportional to
    // length. The contract says nothing may leave that this cannot account
    // for, so the unresolved escapes go rather than being forwarded verbatim
    // for a recipient to finish decoding.
    const deep = pctPercentsN(`%30%78${ADDR.slice(2)}`, 64);
    const out = redactText(deep);
    expect(out).not.toContain('%25');
    expect(out).toContain('…');
    expect(out).not.toContain(ADDR);
  });

  it('takes the hex payload with the escapes it was attached to', () => {
    // Codex r5 P1, and the sharpest finding of the review. Deleting the
    // escape run ALONE was fail-OPEN wearing fail-closed's clothes: with only
    // the `0x` escaped, `%30%78` + forty plain hex digits became
    // `…1234567890abcdef…` — every digit of the account, on a public issue,
    // one fixed two-character prefix from whole. Measured on the real
    // function before the fix, on this branch and the oversized one.
    const deep = pctPercentsN(`%30%78${ADDR.slice(2)}`, 64);
    const out = redactText(deep);
    expect(out).not.toContain(ADDR.slice(2));
    expect(out).not.toContain(ADDR.slice(2, 22));
  });

  it('takes the payload when only the leading zero is encoded', () => {
    // Codex r7 P1. `%30x` spells the same prefix as `%30%78` with just the
    // zero escaped, and the adjacency scan stopped at the literal `x` because
    // `x` is not a hex digit — forwarding `…x1234567890abcdef…`, recoverable
    // by prepending a fixed `0`. The prefix alphabet is `0`, `x`, `X`; two of
    // those were already hex, and the third is the hole.
    const out = redactText(pctPercentsN(`%30x${ADDR.slice(2)}`, 64));
    expect(out).not.toContain(ADDR.slice(2));
    expect(out).not.toContain(`x${ADDR.slice(2, 22)}`);
  });

  it('a run of escaped percent signs is a fixpoint, not an exhaustion', () => {
    // Worth pinning because it corrected my own mental model: `%25%25…`
    // decodes to `%%…`, and a percent followed by a percent is not an escape,
    // so the loop CONVERGES in two passes. Nothing is hidden in it, so the
    // text is returned as it stands rather than being scrubbed. Failing
    // closed here would corrupt ordinary text for no privacy gain.
    const run = '%25'.repeat(2_000);
    expect(redactText(run)).toBe(run);
  });

  it('is bounded — a pathological input returns promptly', () => {
    const deep = pctPercentsN(`%30%78${ADDR.slice(2)}`, 200);
    const started = Date.now();
    const out = redactText(deep);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).not.toContain(ADDR);
  });
});

describe('redactText — very large input stays bounded (#2024 Codex r3)', () => {
  it('handles a multi-megabyte escaped message promptly', () => {
    // `redactCap` redacts BEFORE capping, so a caught provider error arrives
    // here whole even though the caller keeps 1,200 characters. Building a
    // per-character map over megabytes, once per decoding pass, measured
    // ~3.8 s and would leave the Support drawer unusable exactly after the
    // failure someone wants to report.
    const huge = '%25'.repeat(1_000_000);
    const started = Date.now();
    const out = redactText(huge);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out).not.toContain('%25');
  });

  it('still redacts an address inside an oversized message', () => {
    // The address sits BEFORE the bulk, not after it: past the 64 KB ceiling
    // the text is truncated rather than scanned (Codex r4 P2), so an address
    // beyond that point is now dropped instead of shortened — safer, but it
    // means this case has to place the address where a report would keep it.
    const huge = `${ADDR} ${'%41'.repeat(100)} ${'x'.repeat(70_000)}`;
    const out = redactText(huge);
    expect(out).toContain(SHORT);
    expect(out).not.toContain(ADDR);
    expect(out).not.toContain('%41');
  });

  // Codex r4 P2. The case above and the one before it both hid this: a
  // contiguous `%25` run collapses to a SINGLE ellipsis, so output stayed tiny
  // however large the input was, and `'x'.repeat(70_000)` carries no escapes
  // to expand. Escapes SEPARATED by ordinary characters can do neither — every
  // three input characters still yield two of output — so the fallback
  // materialised half the uncapped message before the caller's 1,200-character
  // cap ever ran.
  it('does not materialize output proportional to a huge separated-escape message', () => {
    const huge = '%25x'.repeat(1_000_000);
    expect(huge.length).toBe(4_000_000);
    const started = Date.now();
    const out = redactText(huge);
    expect(Date.now() - started).toBeLessThan(1_000);
    // Half of four million is the number this must not produce. Bounding the
    // input is what holds it down; without the slice this is ~2,000,000.
    expect(out.length).toBeLessThanOrEqual(MAX_MAPPED_INPUT + 1);
  });

  it('still finds an address near the start of a huge separated-escape message', () => {
    // Bounding the scan must not cost the redaction itself for anything the
    // caller would actually keep.
    const out = redactText(`${ADDR} ${'%25x'.repeat(1_000_000)}`);
    expect(out).toContain(SHORT);
    expect(out).not.toContain(ADDR);
  });

  it('takes the hex payload with the escapes in the oversized branch too', () => {
    // The same r5 P1 shape, reached by size rather than by nesting. Both
    // fail-closed branches shared the one regex, so both leaked and both are
    // pinned — fixing only the branch a finding names is how the other one
    // comes back.
    const out = redactText(`%30%78${ADDR.slice(2)} ${'y'.repeat(MAX_MAPPED_INPUT)}`);
    expect(out).not.toContain(ADDR.slice(2));
    expect(out).not.toContain(ADDR.slice(2, 22));
  });

  it('takes the payload when only the leading zero is encoded, oversized too', () => {
    const out = redactText(`%30x${ADDR.slice(2)} ${'y'.repeat(MAX_MAPPED_INPUT)}`);
    expect(out).not.toContain(ADDR.slice(2));
    expect(out).not.toContain(`x${ADDR.slice(2, 22)}`);
  });

  it('drops hex-spelled text adjacent to an escape, which is the price of that', () => {
    // Pinned so the trade is a decision rather than a surprise: in the
    // already-lossy branches, a hex-looking word touching an escape goes with
    // it. There is no length below which a leftover is provably not the
    // remainder of an address, so this is the safe side of the line.
    const out = redactText(`%20decade ${'y'.repeat(MAX_MAPPED_INPUT)}`);
    expect(out).not.toContain('decade');
    // Text NOT touching an escape is untouched, so the loss stays local.
    expect(out).toContain('y');
  });

  it('stays linear on a hex-only head whose first escape is past the cut', () => {
    // Codex r6 P2, and a regression the r5 fix introduced. Expressing "escape
    // run plus adjacent hex" as ONE regex reads correctly and is quadratic:
    // with no `%` in the sliced head, the leading `[a-fA-F0-9]*` consumes to
    // the end and backtracks a character at a time, from every start position.
    // Measured on 64 KB of `a`: 6850 ms for the one-regex form, 1 ms anchored.
    // A fallback whose job is to stop an attacker-controlled error freezing
    // the drawer must not be the thing that freezes it.
    const started = Date.now();
    redactText(`${'a'.repeat(MAX_MAPPED_INPUT)}%25`);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('bounds a huge address-only message, which has no escapes at all', () => {
    // Codex r6 P2. The no-escape fast path is the common one and cheap per
    // character, which is exactly why it sat ABOVE the ceiling and quietly
    // stepped around it. A ceiling the ordinary path can bypass is not a
    // ceiling, so the size check now runs first.
    const huge = `${ADDR} `.repeat(200_000);
    expect(huge).not.toContain('%');
    const out = redactText(huge);
    expect(out.length).toBeLessThanOrEqual(MAX_MAPPED_INPUT + 1);
    expect(out).not.toContain(ADDR);
    expect(out).toContain(SHORT);
  });

  // Codex r9 P1, then a self-probe that showed the r9 fix was a SPELLING
  // rather than the rule. The cut can land inside a `%xx`, and the stranded
  // remainder sits between the address fragment and the end of the string,
  // where the original "must end in hex" rule could not anchor. Stripping an
  // incomplete trailing escape fixed `%3` and nothing else: `%%` survives one
  // strip pass as `%`, and `%z` is not an escape shape at all. Both still
  // forwarded `0x` + 39 hex.
  //
  // So the table is the point. Enumerating what a cut can strand is a losing
  // game, and a single example would have let the next spelling through — the
  // rule is now "a `0x` near the end with no completed shortening after it",
  // which does not care what follows.
  //
  // Checksummed spelling throughout, deliberately: EIP-55 casing is a function
  // of the whole address, so 39 characters plus the casing narrow the missing
  // nibble to a few offline-checkable candidates. A lowercase fixture would
  // understate what a fragment gives away.
  const CHECKSUMMED = '0x1234567890abCDeF1234567890aBcDEF12345678';
  const beyondTheCut = 'z'.repeat(MAX_MAPPED_INPUT);
  const cutAfter = (tail: string): string =>
    `${'q'.repeat(MAX_MAPPED_INPUT - tail.length)}${tail}${beyondTheCut}`;

  for (const [name, stranded] of [
    ['nothing', ''],
    ['a bare percent', '%'],
    ['a half escape', '%3'],
    ['a doubled percent', '%%'],
    ['a percent and a non-hex char', '%z'],
    ['a whole escape the run pass could not use', '%3f'],
  ] as const) {
    it(`drops a boundary fragment followed by ${name}`, () => {
      const out = redactText(cutAfter(`${CHECKSUMMED.slice(0, 41)}${stranded}`));
      expect(out).not.toContain(CHECKSUMMED.slice(2, 22));
      expect(out).not.toContain(CHECKSUMMED.slice(0, 41));
    });
  }

  it('drops an uppercase 0X boundary fragment too', () => {
    const upper = `0X${CHECKSUMMED.slice(2)}`;
    const out = redactText(cutAfter(`${upper.slice(0, 41)}%%`));
    expect(out).not.toContain(upper.slice(2, 22));
  });

  it('KEEPS a completed shortening sitting at the very end', () => {
    // The rule must not buy safety by eating its own output. A shortened
    // address reads `0x1234…5678`, and the ellipsis is what marks it finished.
    expect(redactText(cutAfter(CHECKSUMMED))).toContain('0x1234…5678');
  });

  it('drops an address straddling the truncation boundary rather than halving it', () => {
    // The cut lands 20 characters into the address, leaving `0x` + 18 hex at
    // the end of the head. Half an account is not something a report should
    // forward, so the boundary fragment goes.
    const head = 'x'.repeat(MAX_MAPPED_INPUT - 20);
    const out = redactText(`${head}${ADDR}${'%41'.repeat(200)}`);
    expect(out).not.toContain(ADDR.slice(0, 20));
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('redactText — a hash must survive mixed-depth encoding (#2024 Codex r2/r3)', () => {
  it('does not shorten a hash with a LITERAL head and an escaped tail', () => {
    // Codex r3 P2. The eager literal pass shortened this before the fixpoint
    // could reveal the 64-hex run: `0x` + 40 hex followed by `%` satisfies the
    // negative lookahead, so the head read as an address. The earlier
    // mixed-depth case missed it because that one encodes the head too.
    const hash = `0x${'e'.repeat(64)}`;
    const out = redactText(hash.slice(0, 42) + pctAll(hash.slice(42)));
    expect(out).not.toContain('…');
  });

  it('does not shorten a hash whose head and tail are encoded at different depths', () => {
    // At level 1 the first 42 characters read as an address followed by `%`,
    // and the negative lookahead accepts that. Only at the fixpoint is the
    // full 64-hex run visible and correctly rejected — which is why the
    // search runs there and not at every intermediate level.
    const hash = `0x${'d'.repeat(64)}`;
    const head = pctAll(hash.slice(0, 42));
    const tail = pctAll(pctAll(hash.slice(42)));
    const out = redactText(head + tail);
    expect(out).not.toContain('…');
  });
});

describe('redactText — malformed input must never throw', () => {
  // `decodeURIComponent` rejects all of these. A diagnostics helper that
  // throws becomes a crash source in the crash reporter, which is the one
  // place it must not.
  for (const bad of ['%', '%z', '%zz', '%2', 'a%', '%%%', '100%', '%e0%a4%a']) {
    it(`survives ${JSON.stringify(bad)}`, () => {
      expect(() => redactText(bad)).not.toThrow();
      expect(redactText(bad)).toBe(bad);
    });
  }

  it('still finds an address alongside a malformed escape', () => {
    expect(redactText(`%zz ${pctAll(ADDR)}`)).toBe(`%zz ${SHORT}`);
  });
});

describe('redactCap', () => {
  it('redacts before capping, so truncation cannot strand a partial address', () => {
    // Capping first would cut the address mid-run and leave hex the
    // whole-text scrubber no longer recognises.
    const out = redactCap(`${ADDR} tail`, 12);
    expect(out).not.toContain(ADDR);
    expect(out.startsWith('0x1234…')).toBe(true);
  });

  it('redacts an encoded address before capping too', () => {
    const out = redactCap(pctAll(ADDR), 40);
    expect(out).not.toContain('%30');
    expect(out).toContain('0x1234…5678');
  });
});

describe('redactAddress', () => {
  it('shortens a connected address', () => {
    expect(redactAddress(ADDR)).toBe(SHORT);
  });

  it('says so when there is no wallet', () => {
    expect(redactAddress(undefined)).toBe('not connected');
  });
});
