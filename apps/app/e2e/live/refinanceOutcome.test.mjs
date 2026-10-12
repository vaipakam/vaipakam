/**
 * #2422 (#2431 re-cut) — the outcome helpers, pinned against the REAL accept
 * that refinanced loan 22 into loan 23 on Base Sepolia (tx
 * 0x6651828509c9bcfd01746270a79f8602cc303a06aa1ef853b71ad24c29b0888c, block
 * 47711162).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createManifest } from './outcomeManifest.mjs';
import {
  checkRoleNonces,
  collateralMovedOut,
  LIEN_FIELDS,
  lienCarried,
  requestStateOf,
  scanForReplacement,
  TOPIC,
} from './refinanceOutcome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ABI = JSON.parse(fs.readFileSync(path.join(HERE, '../../../../packages/contracts/src/diamondAbi.json'), 'utf8'));
/** The fields of LibVaipakam.Encumbrance, from the compiled ABI. */
const ENCUMBRANCE_FIELDS = ABI.find((e) => e.name === 'getLoanCollateralLien').outputs[0].components.map((c) => c.name);

const BORROWER = '0xC86BB89f8ddF703c34724Cf11137498bC69F039D';
const LENDER = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
const LENDER_VAULT = '0x7bb370BA877c7f430CB3CD6f2E25e3eE788148F1';
const BORROWER_VAULT = '0x5F2295e0D353D02324d12E32eE7304743b456Ac6';
const TREASURY = '0xca3E735C593088D2f5ea5AEAa553a6bDaa6E7413';
const OLD_LENDER_VAULT = '0xf0724B8448a30AA90cB4EfCFc93af63090B6d030';
const TCOL = '0xF2c65Cd941FE681B575Adc8DFc155Bf612675037';
const WETH = '0x4200000000000000000000000000000000000006';
const pad = (a) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
// The principal-token (WETH) Transfer logs of the real accept receipt, in
// emission order, as raw logs.
const REAL_ACCEPT_TOKEN_LOGS = [
  [LENDER, LENDER_VAULT],
  [LENDER_VAULT, TREASURY],
  [LENDER_VAULT, LENDER],
  [LENDER_VAULT, BORROWER],
  [BORROWER, TREASURY],
  [BORROWER, OLD_LENDER_VAULT],
].map(([from, to]) => ({ address: WETH, topics: [TOPIC.transfer, pad(from), pad(to)] }));

describe('refinanceOutcome — the collateral lien was carried (claim 3)', () => {
  const expected = { user: BORROWER, asset: TCOL, assetType: 0, tokenId: 0n, amount: 100n * 10n ** 18n };
  // getLoanCollateralLien(22) and (23) at the accept block 47711162.
  const REAL = {
    oldAfter: { user: BORROWER, asset: TCOL, tokenId: 0n, amount: 0n, assetType: 0, released: true },
    newAfter: { user: BORROWER, asset: TCOL, tokenId: 0n, amount: 100n * 10n ** 18n, assetType: 0, released: false },
    expected,
  };
  // A value that differs from the real one, per Encumbrance field.
  const OTHER = { user: LENDER, asset: BORROWER, tokenId: 1n, amount: 99n * 10n ** 18n, assetType: 1, released: null };
  const flipped = (lien, field) => ({ ...lien, [field]: field === 'released' ? !lien.released : OTHER[field] });

  it('accepts the real loan-22 → loan-23 liens', () => {
    expect(lienCarried(REAL)).toEqual([]);
  });

  it('LIEN_FIELDS accounts for every Encumbrance field, on both sides, exactly once (#2434 r1 P1)', () => {
    expect(Object.keys(REAL.newAfter).sort()).toEqual([...ENCUMBRANCE_FIELDS].sort());
    for (const side of ['replacement', 'old']) {
      const { compared, notVerified } = LIEN_FIELDS[side];
      const declared = [...compared, ...Object.keys(notVerified)];
      expect(declared.sort(), side).toEqual([...ENCUMBRANCE_FIELDS].sort());
      expect(new Set(declared).size, side).toBe(declared.length);
      for (const [f, why] of Object.entries(notVerified)) expect(why, `${side}.${f}`).toMatch(/\S/);
    }
  });

  it('every field declared compared IS compared, and every field declared not verified is not', () => {
    for (const [side, key] of [['replacement', 'newAfter'], ['old', 'oldAfter']]) {
      for (const field of LIEN_FIELDS[side].compared) {
        const r = lienCarried({ ...REAL, [key]: flipped(REAL[key], field) });
        expect(r, `${side}.${field}`).toHaveLength(1);
        expect(r[0], `${side}.${field}`).toMatch(new RegExp(`^${side === 'old' ? 'old loan' : 'replacement'} lien: ${field} `));
      }
      for (const field of Object.keys(LIEN_FIELDS[side].notVerified)) {
        expect(lienCarried({ ...REAL, [key]: flipped(REAL[key], field) }), `${side}.${field}`).toEqual([]);
      }
    }
  });

  it('the replacement lien must lock the BORROWER\u2019s vault: user is the vault owner, compared with the borrower', () => {
    const r = lienCarried({ ...REAL, newAfter: { ...REAL.newAfter, user: BORROWER_VAULT } });
    expect(r).toEqual([`replacement lien: user (vault owner) ${BORROWER_VAULT}, expected the borrower ${BORROWER}`]);
    // Address case is not a difference.
    expect(lienCarried({ ...REAL, newAfter: { ...REAL.newAfter, user: BORROWER.toLowerCase() } })).toEqual([]);
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
    // The real accept receipt's six token logs — all WETH, none on tCOL.
    expect(collateralMovedOut({ logs: REAL_ACCEPT_TOKEN_LOGS, token: TCOL, from: BORROWER_VAULT, assetType: 0 })).toEqual([]);
    // The same logs read for WETH out of the lender's vault do show legs:
    // the helper is reading them, not skipping them.
    expect(collateralMovedOut({ logs: REAL_ACCEPT_TOKEN_LOGS, token: WETH, from: LENDER_VAULT, assetType: 0 })).toHaveLength(3);
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

  it('a transaction still pending is not a reconciled one', async () => {
    const ok = await checkRoleNonces({ role: 'lender', readNonces: async () => ({ latest: 132, pending: 132 }), baseline: 130, hashed: 2, allowed: 2, record: () => {} });
    expect(ok.ok).toBe(true);
    const queued = await checkRoleNonces({ role: 'lender', readNonces: async () => ({ latest: 132, pending: 133 }), baseline: 130, hashed: 2, allowed: 2, record: () => {} });
    expect(queued).toMatchObject({ recorded: true, ok: false, observed: 'mined +2, pending +1, allowed 2, hashed 2' });
  });
});

describe('refinanceOutcome — a request\u2019s state', () => {
  const offer = (over = {}) => ({ accepted: false, expiresAt: 2_000n, ...over });
  it('a cancelled request that has not expired is NOT open', () => {
    expect(requestStateOf({ offer: offer(), cancelled: true, blockTs: 1_000n })).toBe('cancelled');
  });
  it('open, accepted and expired, by the contract\u2019s own expiry test', () => {
    expect(requestStateOf({ offer: offer(), cancelled: false, blockTs: 1_000n })).toBe('open');
    expect(requestStateOf({ offer: offer({ accepted: true }), cancelled: false, blockTs: 1_000n })).toBe('accepted');
    expect(requestStateOf({ offer: offer(), cancelled: false, blockTs: 2_000n })).toBe('expired');
    expect(requestStateOf({ offer: offer({ expiresAt: 0n }), cancelled: false, blockTs: 9_999n })).toBe('open');
  });
});
