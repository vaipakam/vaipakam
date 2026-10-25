import { describe, expect, it } from 'vitest';
import { activityParticipants } from '@vaipakam/lib/activityParticipants';
import {
  admits,
  compareRendered,
  expectedRows,
  lastChain,
  lastScan,
  namesAsText,
  pickCandidates,
  renderedRows,
} from './activityAdmission.mjs';

// The real rule, as the drive loads it.
const participants = activityParticipants;

const LENDER = '0x1111111111111111111111111111111111111111';
const BORROWER = '0x2222222222222222222222222222222222222222';
const KEEPER = '0x3333333333333333333333333333333333333333';
const TX = (n) => `0x${n.toString(16).padStart(64, '0')}`;

function ev(kind, args, { tx = 1, loanId = null, block = 100 } = {}) {
  return { kind, args, loanId, txHash: tx === null ? '' : TX(tx), blockNumber: block, logIndex: 0 };
}

// A loan start (its two parties), a keeper being permitted on a loan (the
// keeper named, not a party), and the loan's actor-null settlement.
const loanStart = [
  ev('LoanInitiated', { loanId: '7', lender: LENDER, borrower: BORROWER }, { tx: 1, loanId: 7 }),
  ev('LoanInitiatedDetails', { loanId: '7', lender: LENDER, borrower: BORROWER }, { tx: 1, loanId: 7 }),
];
const keeperPermitted = ev('LoanKeeperEnabled', { loanId: '7', keeper: KEEPER, enabled: true }, { tx: 2 });
const settled = ev('LoanSettled', { loanId: '7' }, { tx: 3, loanId: 7 });
const roleGranted = ev('RoleGranted', { role: '0x00', account: KEEPER, sender: LENDER }, { tx: 4 });

describe('admits — the page rule', () => {
  it('admits a named party and the actor', () => {
    expect(admits(loanStart[0], LENDER, new Set(), participants)).toBe(true);
    expect(admits(loanStart[1], BORROWER, new Set(), participants)).toBe(true);
  });
  it('admits an event of one of the wallet’s loans whatever it names', () => {
    expect(admits(settled, BORROWER, new Set([7]), participants)).toBe(true);
    expect(admits(settled, BORROWER, new Set(), participants)).toBe(false);
  });
  it('does not admit an address the event only configures', () => {
    expect(admits(keeperPermitted, KEEPER, new Set(), participants)).toBe(false);
    expect(admits(roleGranted, KEEPER, new Set(), participants)).toBe(false);
    // …while the retired rule would have shown both.
    expect(namesAsText(keeperPermitted, KEEPER)).toBe(true);
    expect(namesAsText(roleGranted, KEEPER)).toBe(true);
  });
  it('reads unparsed args as naming no participant', () => {
    expect(admits(ev('LoanInitiated', `{"lender":"${LENDER}"}`), LENDER, new Set(), participants)).toBe(false);
  });
});

describe('expectedRows', () => {
  it('groups by transaction and separates the named-only ones', () => {
    const r = expectedRows({
      events: [...loanStart, keeperPermitted, roleGranted, settled],
      me: KEEPER,
      loanIds: new Set(),
      participants,
    });
    expect(r.admitted.size).toBe(0);
    expect([...r.namedOnly.keys()]).toEqual([TX(2), TX(4)]);
  });
  it('a transaction with one admitted event is admitted, never named-only', () => {
    const extended = ev('LoanExtended', { loanId: '7', caller: KEEPER }, { tx: 2, loanId: 7 });
    const r = expectedRows({ events: [keeperPermitted, extended], me: KEEPER, loanIds: new Set(), participants });
    expect([...r.admitted.keys()]).toEqual([TX(2)]);
    expect(r.namedOnly.size).toBe(0);
  });
  it('counts admitted events without a hash, which render without a link', () => {
    const noTx = ev('LoanInitiated', { lender: LENDER, borrower: BORROWER }, { tx: null });
    expect(expectedRows({ events: [noTx], me: LENDER, loanIds: new Set(), participants }).admittedWithoutTx).toBe(1);
  });
});

describe('renderedRows + compareRendered', () => {
  const explorer = 'https://sepolia.basescan.org';
  const expected = expectedRows({
    events: [...loanStart, keeperPermitted, settled],
    me: BORROWER,
    loanIds: new Set([7]),
    participants,
  });

  it('passes when the page renders exactly the admitted transactions', () => {
    const rendered = renderedRows([
      { observation: false, href: `${explorer}/tx/${TX(3)}` },
      { observation: false, href: `${explorer}/tx/${TX(1)}` },
      // a #2643 observation links no transaction and is not compared
      { observation: true, href: null },
    ]);
    const cmp = compareRendered(expected, rendered);
    expect(cmp.ok).toBe(true);
    expect(rendered.observations).toBe(1);
  });
  it('names a rendered row the retired rule would show', () => {
    const forKeeper = expectedRows({ events: [keeperPermitted], me: KEEPER, loanIds: new Set(), participants });
    const cmp = compareRendered(forKeeper, renderedRows([{ observation: false, href: `${explorer}/tx/${TX(2)}` }]));
    expect(cmp.ok).toBe(false);
    expect(cmp.namedShown).toEqual([TX(2)]);
  });
  it('reports an admitted transaction left out, and an unadmitted one shown', () => {
    const cmp = compareRendered(
      expected,
      renderedRows([
        { observation: false, href: `${explorer}/tx/${TX(1)}` },
        { observation: false, href: `${explorer}/tx/${TX(9)}` },
      ]),
    );
    expect(cmp.missing).toEqual([TX(3)]);
    expect(cmp.unexpected).toEqual([TX(9)]);
    expect(cmp.namedShown).toEqual([]);
  });
  it('fails on link-less rows the rule does not account for, and on an unreadable link', () => {
    const cmp = compareRendered(
      expected,
      renderedRows([
        { observation: false, href: `${explorer}/tx/${TX(1)}` },
        { observation: false, href: `${explorer}/tx/${TX(3)}` },
        { observation: false, href: null },
        { observation: false, href: `${explorer}/address/${LENDER}` },
      ]),
    );
    expect(cmp.withoutTxMismatch).toEqual({ rendered: 1, expected: 0 });
    expect(cmp.unreadable).toHaveLength(1);
    expect(cmp.ok).toBe(false);
  });
  it('compares transaction hashes case-insensitively', () => {
    const cmp = compareRendered(
      expected,
      renderedRows([
        { observation: false, href: `${explorer}/tx/${TX(1).toUpperCase().replace('0X', '0x')}` },
        { observation: false, href: `${explorer}/tx/${TX(3)}` },
      ]),
    );
    expect(cmp.ok).toBe(true);
  });
});

describe('loans the oracle cannot see', () => {
  const explorer = 'https://sepolia.basescan.org';
  // The page also admits loans the wallet holds on chain (an RPC read this
  // oracle does not make), so a row tied only to a loan outside the indexer
  // legs is neither a pass nor a defect.
  it('reports a rendered row tied to an unseen loan as undetermined, not unexpected', () => {
    const r = expectedRows({ events: [settled], me: BORROWER, loanIds: new Set(), participants });
    expect([...r.outsideLoans.keys()]).toEqual([TX(3)]);
    const cmp = compareRendered(r, renderedRows([{ observation: false, href: `${explorer}/tx/${TX(3)}` }]));
    expect(cmp.undetermined).toEqual([TX(3)]);
    expect(cmp.unexpected).toEqual([]);
    expect(cmp.ok).toBe(true);
  });
  it('keeps a missing admitted row a finding: the unseen loans only ever add rows', () => {
    const r = expectedRows({ events: [settled], me: BORROWER, loanIds: new Set([7]), participants });
    expect(r.outsideLoans.size).toBe(0);
    expect(compareRendered(r, renderedRows([])).missing).toEqual([TX(3)]);
  });
  it('a rendered named-only row with no loan is still the #2703 regression', () => {
    const r = expectedRows({ events: [roleGranted], me: KEEPER, loanIds: new Set(), participants });
    const cmp = compareRendered(r, renderedRows([{ observation: false, href: `${explorer}/tx/${TX(4)}` }]));
    expect(cmp.undetermined).toEqual([]);
    expect(cmp.namedShown).toEqual([TX(4)]);
  });
});

describe('lastChain', () => {
  it('returns the last cursor walk in one series', () => {
    const walk = lastChain([
      { before: null, nextBefore: 'x' },
      { before: null, nextBefore: 'y' },
      { before: 'y', nextBefore: null },
    ]);
    expect(walk).toEqual([
      { before: null, nextBefore: 'y' },
      { before: 'y', nextBefore: null },
    ]);
  });
  it('is null when the walk breaks or never started', () => {
    expect(
      lastChain([
        { before: null, nextBefore: 'a' },
        { before: 'b', nextBefore: null },
      ]),
    ).toBeNull();
    expect(lastChain([])).toBeNull();
  });
});

describe('lastScan', () => {
  const page = (before, nextBefore, events = [], chainId = 84532) => ({ before, nextBefore, events, chainId });
  it('takes the last scan the page started', () => {
    const scan = lastScan([
      page(null, 'a', [loanStart[0]]),
      page('a', null, [settled]),
      page(null, 'b', [keeperPermitted]),
      page('b', null, [roleGranted]),
    ]);
    expect(scan.events).toEqual([keeperPermitted, roleGranted]);
    expect(scan.pages).toBe(2);
    expect(scan.reachedEnd).toBe(true);
  });
  it('refuses a scan whose pages do not chain', () => {
    expect(lastScan([page(null, 'a'), page('z', null)])).toBeNull();
  });
  it('is null with no scan at all', () => {
    expect(lastScan([page('a', null)])).toBeNull();
    expect(lastScan([])).toBeNull();
  });
  it('reports the chains the scan read', () => {
    expect(lastScan([page(null, 'a', [], 84532), page('a', null, [], 421614)]).chainIds).toEqual([84532, 421614]);
  });
});

describe('pickCandidates', () => {
  const events = [...loanStart, keeperPermitted, roleGranted, settled];
  it('picks the most-named-without-admission wallet first, then the most admitted', () => {
    const picks = pickCandidates({ events, participants, max: 2 });
    expect(picks[0]).toMatchObject({ address: KEEPER, namedOnly: 2, admitted: 0 });
    expect(picks[1].admitted).toBeGreaterThan(0);
    expect([LENDER, BORROWER]).toContain(picks[1].address);
  });
  it('skips what isWallet rules out and never repeats a pick', () => {
    const picks = pickCandidates({ events, participants, isWallet: (a) => a !== KEEPER, max: 5 });
    expect(picks.map((p) => p.address)).not.toContain(KEEPER);
    expect(new Set(picks.map((p) => p.address)).size).toBe(picks.length);
  });
  it('never picks the zero address', () => {
    const minted = ev('Transfer', { from: '0x0000000000000000000000000000000000000000', to: LENDER }, { tx: 5 });
    expect(pickCandidates({ events: [minted], participants, max: 5 }).map((p) => p.address)).not.toContain(
      '0x0000000000000000000000000000000000000000',
    );
  });
});
