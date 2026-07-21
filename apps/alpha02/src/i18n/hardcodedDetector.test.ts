/**
 * Regression guard for the AST hardcoded-string detector (#1365).
 *
 * These fixtures are the exact bug shapes #1388 shipped past the old
 * regex scanner: prose spliced around a JSX interpolation, a template
 * literal used as a JSX child, and a user-visible attribute. If the
 * detector ever stops flagging one of these, the guardrail has a hole
 * again — the test fails before that reaches CI.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations.
import { analyzeSource } from '../../scripts/check-hardcoded-strings.mjs';

const strings = (src: string): string[] =>
  (analyzeSource('fixture.tsx', src) as Array<{ s: string }>).map((f) => f.s);

describe('AST hardcoded-string detector (#1365)', () => {
  it('flags prose spliced around a JSX interpolation (the Positions #1388 bug)', () => {
    const src = `const X = () => (
      <span className="row-sub">Offer #{offer.offerId} · waiting for the other side to accept</span>
    );`;
    expect(strings(src)).toContain('· waiting for the other side to accept');
  });

  it('flags a template literal used as a JSX child (the owed-line #1388 bug)', () => {
    const src = `const X = () => (
      <dd>{isRental ? copy.x : \`\${principalStr} + up to ~\${interestStr} interest\`}</dd>
    );`;
    expect(strings(src)).toContain('+ up to ~ interest');
  });

  it('flags prose in a user-visible attribute (the AppShell #1388 bug)', () => {
    const src = `const X = () => (<span title={\`Connected to \${chain.name}\`}>x</span>);`;
    expect(strings(src)).toContain('Connected to');
  });

  it('flags a single prose word adjacent to an interpolation (the #1365 class)', () => {
    const src = `const X = () => (<span>{formatDurationDays(d)} · ends {dueDate}</span>);`;
    expect(strings(src)).toContain('· ends');
  });

  it('does NOT flag a catalog reference', () => {
    const src = `const X = () => (
      <span>{copy.positions.offerRow.waitingAccept(offer.offerId)}</span>
    );`;
    expect(strings(src)).toEqual([]);
  });

  it('does NOT flag glossary-only static text (units, ticker, brand)', () => {
    const src = `const X = () => (
      <>
        <span>{amount} VPFI</span>
        <span title={\`\${rateBps} bps\`}>{pct}</span>
        <span>#{id}</span>
        <span>{sym} · {formatBpsAsPercent(bps)}</span>
      </>
    );`;
    expect(strings(src)).toEqual([]);
  });

  it('does NOT flag non-UI attributes (className / href / to)', () => {
    const src = `const X = () => (
      <a className={\`btn \${active ? 'btn-primary' : 'btn-secondary'}\`} href={\`/positions/\${id}\`} to={\`/borrow?offer=\${id}\`}>x</a>
    );`;
    expect(strings(src)).toEqual([]);
  });

  // --- Codex #1394 round-1 coverage gaps ---

  it('flags the visible custom props heading / text / tooltip', () => {
    expect(strings('const X = () => <EmptyState heading="No offers yet" />;')).toContain(
      'No offers yet',
    );
    expect(strings('const X = () => <HelpTip tooltip="Close position" />;')).toContain(
      'Close position',
    );
  });

  it('flags prose inside a template interpolation expression', () => {
    const src = "const X = () => <span>{`${n === 1 ? 'day' : 'days'}`}</span>;";
    expect(strings(src)).toContain('day');
    expect(strings(src)).toContain('days');
  });

  it('flags a literal wrapped in a type-only expression (as const / non-null)', () => {
    expect(strings("const X = () => <span>{'Loading offers' as const}</span>;")).toContain(
      'Loading offers',
    );
    expect(strings("const X = () => <span>{('Failed to load')!}</span>;")).toContain(
      'Failed to load',
    );
  });

  it('flags visible option labels inside object-valued props', () => {
    const src = "const X = () => <SelectMenu options={[{ value: 'newest', label: 'Newest first' }]} />;";
    expect(strings(src)).toContain('Newest first');
  });

  it('flags user-visible attributes supplied via a spread of an object literal', () => {
    const src = "const X = () => <input {...{ placeholder: 'Search offers' }} />;";
    expect(strings(src)).toContain('Search offers');
  });
});
