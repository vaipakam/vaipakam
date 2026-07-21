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

  // --- Codex #1394 round-2 coverage gaps ---

  it('flags a hardcoded string argument to a copy.* template call', () => {
    const src = "const X = () => <span>{copy.tokenSecurity.gateUnknown('prepayment token')}</span>;";
    expect(strings(src)).toContain('prepayment token');
  });

  it('does NOT flag string arguments to non-copy calls (no data-flow guessing)', () => {
    const src = "const X = () => <span>{formatSomething('Some words here')}</span>;";
    expect(strings(src)).toEqual([]);
  });

  it('flags custom copy props body / hint / confirmLabel', () => {
    expect(strings('const X = () => <UnavailableState body="Try again later" />;')).toContain(
      'Try again later',
    );
    expect(strings('const X = () => <ConfirmReceipt confirmLabel="Confirm payment" />;')).toContain(
      'Confirm payment',
    );
  });

  it('flags SelectMenu option secondary fields sub / controlLabel', () => {
    const src =
      "const X = () => <SelectMenu options={[{ value: 'n', sub: 'Second line', controlLabel: 'Closed label' }]} />;";
    expect(strings(src)).toContain('Second line');
    expect(strings(src)).toContain('Closed label');
  });

  // --- Codex #1394 round-3 coverage gaps ---

  it('flags a hardcoded string on the React children prop', () => {
    expect(strings('const X = () => <Button children="Click me" />;')).toContain('Click me');
  });

  it('flags copy.* call args built OUTSIDE a rendered position (thrown / setError)', () => {
    const thrown = "function f() { throw new Error(copy.tokenSecurity.gateUnknown('prepayment token')); }";
    expect(strings(thrown)).toContain('prepayment token');
    const setErr = "const X = () => { setError(copy.errors.pick('some label here')); return null; };";
    expect(strings(setErr)).toContain('some label here');
  });

  it('flags hardcoded copy-container fields (blurb / amountLabel / doneBody)', () => {
    const src = "const jobs = [{ id: 1, blurb: 'Lock collateral you own' }];";
    expect(strings(src)).toContain('Lock collateral you own');
  });

  it('still ignores non-copy call args, even in a throw', () => {
    expect(strings("function f() { throw new Error(fmt('Some words here')); }")).toEqual([]);
  });

  // --- Codex #1394 round-4 coverage gaps ---

  it('flags security-leg labels via the leg object key', () => {
    const src = "const legs = [{ leg: 'loan asset' }, { leg: 'collateral' }];";
    expect(strings(src)).toContain('loan asset');
    expect(strings(src)).toContain('collateral');
  });

  it('flags FaucetRow blurb / actionLabel props', () => {
    const src = 'const X = () => <FaucetRow blurb="Mint test tokens" actionLabel="Mint now" />;';
    expect(strings(src)).toContain('Mint test tokens');
    expect(strings(src)).toContain('Mint now');
  });

  // --- Codex #1394 round-5 coverage gaps ---

  it('flags string elements of an array literal rendered as a JSX child', () => {
    expect(strings("const X = () => <>{['Loading offers']}</>;")).toContain('Loading offers');
  });

  it('flags ReviewReceipt data fields', () => {
    const src = "const X = () => <ReviewReceipt data={{ youReceive: 'Test tokens', fees: 'No fee' }} />;";
    expect(strings(src)).toContain('Test tokens');
    expect(strings(src)).toContain('No fee');
  });

  it('flags short two-letter UI labels (No / On / Go / OK)', () => {
    expect(strings('const X = () => <button>No</button>;')).toContain('No');
    expect(strings('const X = () => <button>Go</button>;')).toContain('Go');
    expect(strings('const X = () => <button>OK</button>;')).toContain('OK');
  });

  it('still drops single-letter tokens (units / separators / articles)', () => {
    // "d" is dropped; only the real word "left" is flagged.
    expect(strings('const X = () => <span>{n}d left</span>;')).toEqual(['d left']);
    expect(strings('const X = () => <span>{a} × {b}</span>;')).toEqual([]);
  });

  // --- Codex #1394 round-6 coverage gaps ---

  it('flags the whole camelCase copy-field family via suffix (Label/Title/Body/Hint/…)', () => {
    // OfferFlow SideCopy shape: any *Label/*Title/*Body/*Hint field carrying
    // a hardcoded literal is caught without enumerating every field name.
    const src =
      "const t = { rateLabel: 'Rate', submitLabel: 'Submit', doneTitle: 'Done', amountHint: 'Amount', acceptDoneBody: 'Accepted' };";
    const out = strings(src);
    expect(out).toContain('Rate');
    expect(out).toContain('Submit');
    expect(out).toContain('Done');
    expect(out).toContain('Amount');
    expect(out).toContain('Accepted');
  });

  it('flags a suffix-matched user-visible attribute (RateLadder takeLabel)', () => {
    expect(strings('const X = () => <RateLadder takeLabel="Take offer" />;')).toContain(
      'Take offer',
    );
  });

  it('flags each rendered element of a steps={[...]} prop (StepNav)', () => {
    const out = strings("const X = () => <StepNav steps={['Pick asset', 'Confirm terms']} />;");
    expect(out).toContain('Pick asset');
    expect(out).toContain('Confirm terms');
  });

  it('does NOT sweep lowercase words that merely end in a suffix (context / subtext)', () => {
    // `context` ends in "text" but not "Text" — code, not copy. The suffix
    // rule matches capitalized boundaries only, so it is not flagged.
    expect(strings("const X = () => <C context='some code value' subtext='more' />;")).toEqual([]);
  });

  // --- Codex #1394 round-7 coverage gaps ---

  it('flags a hardcoded arg passed through a copy.* branch alias (the desk pattern)', () => {
    const src =
      "const text = copy.tokenSecurity; const X = () => <span>{text.gateUnknown('prepayment token')}</span>;";
    expect(strings(src)).toContain('prepayment token');
  });

  it('does NOT flag calls rooted at a non-copy alias (no data-flow guessing)', () => {
    const src =
      "const fmt = helper.thing; const X = () => <span>{fmt.build('Some words here')}</span>;";
    expect(strings(src)).toEqual([]);
  });

  it('flags UI-attribute names supplied via an object spread (children / steps)', () => {
    expect(strings("const X = () => <Button {...{ children: 'Click me' }} />;")).toContain(
      'Click me',
    );
    expect(strings("const X = () => <StepNav {...{ steps: ['Pick asset'] }} />;")).toContain(
      'Pick asset',
    );
  });

  it('flags prose inside a tagged template used as a JSX child', () => {
    expect(strings('const X = () => <span>{String.raw`Switch network`}</span>;')).toContain(
      'Switch network',
    );
  });

  it('does NOT flag a submit input value (refuted — form values, not copy)', () => {
    // The app uses <button> (child text already scanned), not submit inputs;
    // treating `value` as copy would false-positive on <option value="…"> and
    // text-input values. Left out deliberately — see the round-7 refute.
    expect(strings("const X = () => <input type='submit' value='Place order' />;")).toEqual([]);
  });
});
