/**
 * #2422 r8 — the refinance outcome helpers, pinned against the REAL accept
 * that refinanced loan 22 into loan 23 on Base Sepolia (tx
 * 0x6651828509c9bcfd01746270a79f8602cc303a06aa1ef853b71ad24c29b0888c, block
 * 47711162). Every input below is a view value read at block 47711161 and
 * every expected output is the delta or log the chain recorded — the model
 * reproduces each to the wei.
 */
import { describe, expect, it } from 'vitest';

import { createManifest } from './outcomeManifest.mjs';
import {
  checkRoleNonces,
  collateralMovedOut,
  expectedPrincipalTransfers,
  expectedSettlement,
  lienMismatches,
  payoutOwnerOf,
  scanForReplacement,
  scopeReason,
  settlementPremises,
  TOPIC,
  transferMismatches,
  txIsolation,
} from './refinanceOutcome.mjs';

const BORROWER = '0xC86BB89f8ddF703c34724Cf11137498bC69F039D';
const LENDER = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
const LENDER_VAULT = '0x7bb370BA877c7f430CB3CD6f2E25e3eE788148F1';
const TREASURY = '0xca3E735C593088D2f5ea5AEAa553a6bDaa6E7413';
const OLD_LENDER_VAULT = '0xf0724B8448a30AA90cB4EfCFc93af63090B6d030';
const TCOL = '0xF2c65Cd941FE681B575Adc8DFc155Bf612675037';

const LOAN22_AT_P = {
  repayDue: 5_039_726_027_397_260n, // calculateRepaymentAmount(22) @ 47711161
  oldPrincipal: 5_000_000_000_000_000n,
  treasuryFeeBpsAtInit: 200,
  newPrincipal: 5_000_000_000_000_000n,
  lifBps: 20n, // getProtocolConfigBundle()[1] @ 47711161
  matcherBps: 100n, // getProtocolConfigBundle()[12] @ 47711161
};
const PARTIES = {
  borrower: BORROWER,
  lender: LENDER,
  lenderVault: LENDER_VAULT,
  treasury: TREASURY,
  oldLenderVault: OLD_LENDER_VAULT,
  newPrincipal: LOAN22_AT_P.newPrincipal,
};
// The principal-token (WETH) Transfer logs of the real accept receipt, in
// emission order.
const REAL_TRANSFERS = [
  { from: LENDER, to: LENDER_VAULT, value: 5_000_000_000_000_000n },
  { from: LENDER_VAULT, to: TREASURY, value: 9_900_000_000_000n },
  { from: LENDER_VAULT, to: LENDER, value: 100_000_000_000n },
  { from: LENDER_VAULT, to: BORROWER, value: 4_990_000_000_000_000n },
  { from: BORROWER, to: TREASURY, value: 794_520_547_945n },
  { from: BORROWER, to: OLD_LENDER_VAULT, value: 5_038_931_506_849_315n },
];

describe('refinanceOutcome — settlement from the contract views', () => {
  it('reproduces the real loan-22 accept to the wei', () => {
    const s = expectedSettlement(LOAN22_AT_P);
    // The old lender's claim went 0 → 5038931506849315 and their vault rose
    // by the same; the borrower's wallet fell 49726027397260; the accepting
    // lender's wallet fell 4999900000000000 (principal less the matcher cut);
    // the treasury rose 10694520547945.
    expect(s.interestPortion).toBe(39_726_027_397_260n);
    expect(s.treasuryShare).toBe(794_520_547_945n);
    expect(s.lenderDue).toBe(5_038_931_506_849_315n);
    expect(s.oldLenderVaultDelta).toBe(5_038_931_506_849_315n);
    expect(s.lif).toBe(10_000_000_000_000n);
    expect(s.matcherCut).toBe(100_000_000_000n);
    expect(s.borrowerWalletDelta).toBe(-49_726_027_397_260n);
    expect(s.lenderWalletDelta).toBe(-4_999_900_000_000_000n);
    expect(s.treasuryDelta).toBe(10_694_520_547_945n);
  });

  it('falls back to the legacy 100 bps for an unstamped loan', () => {
    const s = expectedSettlement({ ...LOAN22_AT_P, treasuryFeeBpsAtInit: 0 });
    expect(s.feeBps).toBe(100n);
    expect(s.treasuryShare).toBe(397_260_273_972n);
  });

  it('refuses a payoff view below the principal (not an Active loan’s payoff)', () => {
    expect(() => expectedSettlement({ ...LOAN22_AT_P, repayDue: 0n })).toThrow(/below the principal/);
  });

  it('expects exactly the real receipt’s principal-token transfers', () => {
    const want = expectedPrincipalTransfers(expectedSettlement(LOAN22_AT_P), PARTIES);
    expect(transferMismatches(want, REAL_TRANSFERS)).toEqual([]);
    // Order is not the claim; the multiset is.
    expect(transferMismatches(want, [...REAL_TRANSFERS].reverse())).toEqual([]);
  });

  it('refuses a missing, an extra, or a mis-sized transfer', () => {
    const want = expectedPrincipalTransfers(expectedSettlement(LOAN22_AT_P), PARTIES);
    expect(transferMismatches(want, REAL_TRANSFERS.filter((t) => t.to !== OLD_LENDER_VAULT))).toEqual([
      `missing transfer ${BORROWER.toLowerCase()}→${OLD_LENDER_VAULT.toLowerCase()}:5038931506849315`,
    ]);
    const extra = [...REAL_TRANSFERS, { from: BORROWER, to: '0x000000000000000000000000000000000000dEaD', value: 1n }];
    expect(transferMismatches(want, extra)).toHaveLength(1);
    expect(transferMismatches(want, extra)[0]).toMatch(/^unexpected transfer/);
    // A payoff one wei short to the old lender is two mismatches: the
    // expected leg missing and the actual one unexpected.
    const short = REAL_TRANSFERS.map((t) => (t.to === OLD_LENDER_VAULT ? { ...t, value: t.value - 1n } : t));
    expect(transferMismatches(want, short)).toHaveLength(2);
    // A matcher cut paid to someone other than the accepting lender.
    const elsewhere = REAL_TRANSFERS.map((t) => (t.to === LENDER ? { ...t, to: BORROWER } : t));
    expect(transferMismatches(want, elsewhere)).toHaveLength(2);
  });

  it('omits zero-value legs the contract skips', () => {
    const s = expectedSettlement({ ...LOAN22_AT_P, matcherBps: 0n });
    const want = expectedPrincipalTransfers(s, PARTIES);
    expect(want.some((t) => t.to === LENDER)).toBe(false);
    expect(want).toHaveLength(5);
  });
});

describe('refinanceOutcome — the collateral lien carries over', () => {
  const live = { user: BORROWER, asset: TCOL, tokenId: 0n, amount: 100n * 10n ** 18n, assetType: 0, released: false };
  const expected = { user: BORROWER, asset: TCOL, assetType: 0, tokenId: 0n, amount: 100n * 10n ** 18n };
  // getLoanCollateralLien(22) @ 47711161, (22) @ 47711162, (23) @ 47711162.
  const REAL = {
    oldBefore: live,
    oldAfter: { ...live, amount: 0n, released: true },
    newAfter: { ...live },
    expected,
  };

  it('accepts the real loan-22 → loan-23 liens', () => {
    expect(lienMismatches(REAL)).toEqual([]);
  });

  it('refuses an old lien left live or unzeroed', () => {
    expect(lienMismatches({ ...REAL, oldAfter: { ...REAL.oldAfter, released: false } })).toEqual([
      'old loan lien at the accept: released false, expected true',
    ]);
    expect(lienMismatches({ ...REAL, oldAfter: { ...REAL.oldAfter, amount: 1n } })).toEqual([
      'old loan lien at the accept: amount 1, expected 0',
    ]);
  });

  it('refuses a replacement lien that differs in any field, or is not live', () => {
    for (const [field, value] of [
      ['user', LENDER],
      ['asset', BORROWER],
      ['assetType', 1],
      ['tokenId', 1n],
      ['amount', 99n * 10n ** 18n],
      ['released', true],
    ]) {
      const r = lienMismatches({ ...REAL, newAfter: { ...REAL.newAfter, [field]: value } });
      expect(r, field).toHaveLength(1);
      expect(r[0], field).toMatch(new RegExp(`^replacement lien at the accept: ${field} `));
    }
  });

  it('refuses an old lien that was not live before the accept', () => {
    expect(lienMismatches({ ...REAL, oldBefore: { ...live, released: true } })[0]).toMatch(/^old loan lien before the accept: released true/);
  });
});

describe('refinanceOutcome — the replacement scan states its limit', () => {
  /** A chain whose loans 23.. are `ids`, then empty. */
  const chain = (loans) => async (id) => loans.find((l) => l.id === id) ?? { id: 0n, offerId: 0n };

  it('finds the replacement and stops at the empty id', async () => {
    const readLoan = chain([{ id: 23n, offerId: 45n }, { id: 24n, offerId: 46n }]);
    expect(await scanForReplacement({ readLoan, startId: 23n, requestId: 45n, cap: 10 })).toEqual({ id: 23n, offerId: 45n });
  });

  it('"none" only when the empty id is reached', async () => {
    const readLoan = chain([{ id: 23n, offerId: 9n }]);
    expect(await scanForReplacement({ readLoan, startId: 23n, requestId: 45n, cap: 10 })).toBeNull();
  });

  it('exhausting the cap is UNKNOWN (throws), never "none"', async () => {
    // Every id is occupied: the cap runs out before any empty id.
    const readLoan = async (id) => ({ id, offerId: 1n });
    await expect(scanForReplacement({ readLoan, startId: 23n, requestId: 45n, cap: 5 })).rejects.toThrow(
      /read 5 loan ids \(#23–#27\) without reaching an empty id/,
    );
    // Even with a match found, an exhausted cap cannot rule out a second.
    const withMatch = async (id) => ({ id, offerId: id === 24n ? 45n : 1n });
    await expect(scanForReplacement({ readLoan: withMatch, startId: 23n, requestId: 45n, cap: 5 })).rejects.toThrow(/one was found at #24/);
  });

  it('two loans carrying the request is an error', async () => {
    const readLoan = chain([{ id: 23n, offerId: 45n }, { id: 24n, offerId: 45n }]);
    await expect(scanForReplacement({ readLoan, startId: 23n, requestId: 45n, cap: 10 })).rejects.toThrow(/two loans/);
  });
});

// ---------------------------------------------------------------------
// #2422 r9 — the model's premises, the block's scope, the vault, nonces.
// ---------------------------------------------------------------------

describe('refinanceOutcome — settlement premises (the default fee posture)', () => {
  // Loan 22 at block 47711161: the borrower CONSENTS but
  // its effective discount is 0 bps; request #45 not Full; the old lender
  // holder has no consent; loan 22's lenderMode is None (0).
  const LOAN22 = { borrowerEffBps: 0, requestCreatorFull: false, holderConsent: false, lenderMode: 0 };

  it('holds for the real loan-22 posture', () => {
    const p = settlementPremises(LOAN22);
    expect(p.holds).toBe(true);
    expect(p.failures).toEqual([]);
    expect(p.basis.join(' | ')).toMatch(/effective discount 0 bps/);
  });

  // #2422 r11: the premise no longer reads liquidity (external oracle/pool
  // state no isolation check covers). A non-zero discount or a Full opt-in
  // is outside the model whatever the principal's liquidity.
  it('a borrower discount or Full opt-in breaks the premise — liquidity is not an input', () => {
    const tier = settlementPremises({ ...LOAN22, borrowerEffBps: 1000 });
    expect(tier.holds).toBe(false);
    expect(tier.failures[0].party).toBe('borrower');
    expect(tier.failures[0].reason).toMatch(/effective discount is 1000 bps/);
    expect(tier.failures[0].reason).toMatch(/does not depend on the principal\u2019s liquidity/);
    expect(settlementPremises({ ...LOAN22, borrowerEffBps: 0, requestCreatorFull: true }).failures[0].reason).toMatch(/Full opt-in/);
    // An illiquid-principal flag passed in is ignored: still outside the model.
    expect(settlementPremises({ ...LOAN22, principalLiquidity: 1, borrowerEffBps: 1000 }).holds).toBe(false);
  });

  it('any yield-fee entitlement of the exiting holder breaks the premise (VPFI-paid or direct reduction)', () => {
    const consent = settlementPremises({ ...LOAN22, holderConsent: true });
    expect(consent.holds).toBe(false);
    expect(consent.failures[0].party).toBe('exiting lender');
    expect(consent.failures[0].coveredBy).toMatch(/FeeEntitlementFacetTest/);
    expect(settlementPremises({ ...LOAN22, lenderMode: 2 }).failures[0].reason).toMatch(/Full tariff on the loan/);
    // HoldOnly (1) alone is not eligibility: lenderYieldFeeEligible needs consent or Full.
    expect(settlementPremises({ ...LOAN22, lenderMode: 1 }).holds).toBe(true);
  });

  it('reports both parties when both fail', () => {
    expect(settlementPremises({ ...LOAN22, borrowerEffBps: 500, holderConsent: true }).failures.map((f) => f.party)).toEqual([
      'borrower',
      'exiting lender',
    ]);
  });
});

const ACCEPT = '0x6651828509c9bcfd01746270a79f8602cc303a06aa1ef853b71ad24c29b0888c';
const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const BORROWER_VAULT = '0x5F2295e0D353D02324d12E32eE7304743b456Ac6';
const pad = (a) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const WATCHED = { borrower: BORROWER, lender: LENDER, borrowerVault: BORROWER_VAULT, oldLenderVault: OLD_LENDER_VAULT };
const rc = (hash, over = {}) => ({ transactionHash: hash, status: '0x1', from: '0x000000000000000000000000000000000000aaaa', to: '0x000000000000000000000000000000000000bbbb', logs: [], ...over });
const OTHER = `0x${'1'.repeat(64)}`;
const ACCEPT_RCPT = { transactionHash: ACCEPT, blockNumber: 47_711_162n };

describe('refinanceOutcome — the accept block’s other transactions', () => {
  it('an unreadable block is not isolation', () => {
    expect(txIsolation({ receipt: ACCEPT_RCPT, receipts: null, diamond: DIAMOND, watched: WATCHED })).toEqual({ known: false, isolated: false, touching: [], own: [] });
    // A receipt list that does not even contain the accept is not the block.
    expect(txIsolation({ receipt: ACCEPT_RCPT, receipts: [rc(OTHER)], diamond: DIAMOND, watched: WATCHED }).known).toBe(false);
  });

  it('receipts from another block are not this block', () => {
    const r = txIsolation({ receipt: ACCEPT_RCPT, receipts: [rc(ACCEPT, { blockNumber: '0x2d80a3a' }), rc(OTHER, { blockNumber: '0x2d80a3b' })], diamond: DIAMOND, watched: WATCHED });
    expect(r.known).toBe(false);
    expect(r.touching[0]).toMatch(/from a block other than 47711162/);
  });

  it('takes ANY of this run\u2019s receipts — a createOffer\u2019s block is scoped the same way', () => {
    const create = { transactionHash: OTHER, blockNumber: 47_700_000n };
    const r = txIsolation({ receipt: create, receipts: [rc(OTHER), rc(ACCEPT, { logs: [{ address: DIAMOND, topics: [`0x${'2'.repeat(64)}`] }] })], diamond: DIAMOND, watched: WATCHED });
    expect(r.isolated).toBe(false);
    expect(r.touching[0]).toMatch(new RegExp(`^${ACCEPT}: a Diamond log`));
  });

  it('sets aside this run\u2019s OTHER plan transactions by name — and only those', () => {
    const approve = `0x${'4'.repeat(64)}`;
    const approveRc = rc(approve, { from: LENDER, logs: [{ address: '0x4200000000000000000000000000000000000006', topics: [`0x${'8'.repeat(64)}`, pad(LENDER), pad(DIAMOND)] }] });
    const withOwn = txIsolation({ receipt: ACCEPT_RCPT, receipts: [rc(ACCEPT), approveRc], diamond: DIAMOND, watched: WATCHED, own: [approve] });
    expect(withOwn).toEqual({ known: true, isolated: true, touching: [], own: [approve] });
    // The same transaction, not declared as ours, breaks isolation.
    const without = txIsolation({ receipt: ACCEPT_RCPT, receipts: [rc(ACCEPT), approveRc], diamond: DIAMOND, watched: WATCHED });
    expect(without.isolated).toBe(false);
    expect(without.touching[0]).toMatch(/from lender/);
  });

  it('states why a scope is not isolated, and nothing when it is', () => {
    expect(scopeReason({ known: true, isolated: true, touching: [] }, { what: 'the accept', block: 9n })).toBeNull();
    expect(scopeReason({ known: false, isolated: false, touching: [] }, { what: 'the accept', block: 9n, error: 'rpc down' })).toMatch(
      /receipts of the accept's block 9 could not be established \(rpc down\)/,
    );
    expect(scopeReason({ known: true, isolated: false, touching: ['0xab: a Diamond log'] }, { what: 'createOffer', block: 9n })).toMatch(
      /1 other transaction\(s\) in createOffer's block 9 touched the Diamond or a participant: 0xab: a Diamond log/,
    );
  });

  it('unrelated traffic leaves the accept isolated (block 47711162 had 133 such transactions)', () => {
    const unrelated = rc(OTHER, { logs: [{ address: '0x96e582dc68e66613bcb1996320844a3fb28c07d8', topics: [TOPIC.transfer, pad('0x000000000000000000000000000000000000cccc'), pad('0x000000000000000000000000000000000000dddd')] }] });
    const r = txIsolation({ receipt: ACCEPT_RCPT, receipts: [unrelated, rc(ACCEPT, { from: LENDER, to: DIAMOND })], diamond: DIAMOND, watched: WATCHED });
    expect(r).toEqual({ known: true, isolated: true, touching: [], own: [] });
  });

  it('flags a Diamond log, a participant named in a token transfer, a vault log, and a participant’s own transaction', () => {
    const cases = [
      [rc(OTHER, { logs: [{ address: DIAMOND, topics: [`0x${'2'.repeat(64)}`] }] }), /a Diamond log/],
      [rc(OTHER, { logs: [{ address: TCOL, topics: [TOPIC.transfer, pad(BORROWER_VAULT), pad('0x000000000000000000000000000000000000dddd')] }] }), /naming borrowerVault/],
      [rc(OTHER, { logs: [{ address: '0x4200000000000000000000000000000000000006', topics: [TOPIC.transfer, pad('0x000000000000000000000000000000000000dddd'), pad(OLD_LENDER_VAULT)] }] }), /naming oldLenderVault/],
      [rc(OTHER, { logs: [{ address: BORROWER_VAULT, topics: [`0x${'3'.repeat(64)}`] }] }), /a log emitted by borrowerVault/],
      [rc(OTHER, { from: LENDER }), /from lender/],
      [rc(OTHER, { to: DIAMOND }), /sent to the Diamond/],
    ];
    for (const [other, why] of cases) {
      const r = txIsolation({ receipt: ACCEPT_RCPT, receipts: [rc(ACCEPT), other], diamond: DIAMOND, watched: WATCHED });
      expect(r.isolated, String(why)).toBe(false);
      expect(r.touching[0], String(why)).toMatch(why);
    }
  });
});

describe('refinanceOutcome — collateral leaving the borrower’s vault (accept receipt only)', () => {
  const x = '0x000000000000000000000000000000000000dddd';
  it('finds an ERC-20 / ERC-721 Transfer out of the vault, and nothing else', () => {
    const out20 = { address: TCOL, topics: [TOPIC.transfer, pad(BORROWER_VAULT), pad(x)] };
    const in20 = { address: TCOL, topics: [TOPIC.transfer, pad(x), pad(BORROWER_VAULT)] };
    const otherToken = { address: '0x4200000000000000000000000000000000000006', topics: [TOPIC.transfer, pad(BORROWER_VAULT), pad(x)] };
    expect(collateralMovedOut({ logs: [in20, otherToken], token: TCOL, from: BORROWER_VAULT, assetType: 0 })).toEqual([]);
    expect(collateralMovedOut({ logs: [out20], token: TCOL, from: BORROWER_VAULT, assetType: 0 })).toHaveLength(1);
    const out721 = { address: TCOL, topics: [TOPIC.transfer, pad(BORROWER_VAULT), pad(x), `0x${'0'.repeat(63)}7`] };
    expect(collateralMovedOut({ logs: [out721], token: TCOL, from: BORROWER_VAULT, assetType: 1 })[0]).toMatch(/^ERC-721 Transfer/);
  });

  it('reads ERC-1155 movements by their FROM (the second indexed address), not the operator', () => {
    const single = { address: TCOL, topics: [TOPIC.transferSingle, pad(x), pad(BORROWER_VAULT), pad(x)] };
    const batch = { address: TCOL, topics: [TOPIC.transferBatch, pad(x), pad(BORROWER_VAULT), pad(x)] };
    const operatorOnly = { address: TCOL, topics: [TOPIC.transferSingle, pad(BORROWER_VAULT), pad(x), pad(BORROWER_VAULT)] };
    expect(collateralMovedOut({ logs: [single, batch, operatorOnly], token: TCOL, from: BORROWER_VAULT, assetType: 2 })).toHaveLength(2);
    expect(() => collateralMovedOut({ logs: [], token: TCOL, from: BORROWER_VAULT, assetType: 3 })).toThrow(/unknown asset type/);
  });

  it('the real loan-22 accept moved no collateral out of the borrower’s vault', () => {
    // The real receipt's logs on the collateral token: none (its six token
    // logs are all WETH — REAL_TRANSFERS above).
    expect(collateralMovedOut({ logs: [], token: TCOL, from: BORROWER_VAULT, assetType: 0 })).toEqual([]);
  });
});

describe('refinanceOutcome — each role’s nonces are their own check', () => {
  const discipline = () =>
    createManifest({
      verifiable: [
        {
          id: 'writeDiscipline',
          claim: 'every write was planned',
          checks: { borrowerNonces: 'borrower nonces', lenderNonces: 'lender nonces', noRefusals: 'refusal logs' },
        },
      ],
    });

  it('a lender read that throws leaves writeDiscipline unverified', async () => {
    const m = discipline();
    const record = (key, ok, ev) => m.record('writeDiscipline', key, ok, ev);
    const b = await checkRoleNonces({ role: 'borrower', readNonces: async () => ({ latest: 89, pending: 89 }), baseline: 86, hashed: 3, allowed: 3, record });
    expect(b).toMatchObject({ recorded: true, ok: true });
    const l = await checkRoleNonces({
      role: 'lender',
      readNonces: async () => {
        throw new Error('RPC timeout');
      },
      baseline: 130,
      hashed: 2,
      allowed: 2,
      record,
    });
    expect(l).toEqual({ recorded: false, error: 'RPC timeout' });
    m.record('writeDiscipline', 'noRefusals', true, 'none');
    const row = m.rows()[0];
    expect(row.status).toBe('not run');
    expect(row.checks.find((c) => c.key === 'lenderNonces').status).toBe('not run');
    expect(m.passed()).toBe(false);
  });

  it('records a mismatch as a failure when the read succeeds', async () => {
    const m = discipline();
    const r = await checkRoleNonces({
      role: 'lender',
      readNonces: async () => ({ latest: 133, pending: 133 }),
      baseline: 130,
      hashed: 2,
      allowed: 2,
      record: (key, ok, ev) => m.record('writeDiscipline', key, ok, ev),
    });
    expect(r.ok).toBe(false);
    expect(m.rows()[0].status).toBe('failed');
  });
});

// #2422 r11 — the payout owner follows the contract's consolidation.
describe('refinanceOutcome — the old lender\u2019s payout owner', () => {
  const OLD = '0x648897f2c549956eFfF626D57fBc3E39761e6792';
  const BUYER = '0x000000000000000000000000000000000000b0b0';
  it('is the stored lender AFTER the accept, not before (a transferred position)', () => {
    // The position NFT was sold to BUYER; the accept consolidated the stored
    // lender from OLD to BUYER and paid BUYER's vault.
    const r = payoutOwnerOf({ storedLenderAtFloor: BUYER, storedLenderAtPrev: OLD, holderAtPrev: BUYER, floor: 9n, prev: 8n });
    expect(r.owner).toBe(BUYER);
    expect(r.consolidated).toBe(true);
    expect(r.evidence).toMatch(/stored lender before the accept was 0x6488/);
  });
  it('states a skipped consolidation when the holder differs', () => {
    const r = payoutOwnerOf({ storedLenderAtFloor: OLD, storedLenderAtPrev: OLD, holderAtPrev: BUYER, floor: 9n, prev: 8n });
    expect(r.owner).toBe(OLD);
    expect(r.consolidated).toBe(false);
    expect(r.evidence).toMatch(/DIFFERS from the lender-NFT holder at block 8/);
  });
  it('loan 22: holder, stored lender and payout owner were all the original lender', () => {
    const r = payoutOwnerOf({ storedLenderAtFloor: OLD, storedLenderAtPrev: OLD, holderAtPrev: OLD, floor: 47_711_162n, prev: 47_711_161n });
    expect(r).toMatchObject({ owner: OLD, consolidated: true });
    expect(r.evidence).not.toMatch(/DIFFERS|before the accept was/);
  });
});

