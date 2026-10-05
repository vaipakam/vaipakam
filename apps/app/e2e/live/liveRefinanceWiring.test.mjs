/**
 * #2422 r11 — the driver-side wiring that the pure modules cannot see.
 * `live-refinance.mjs` runs only against the live chain, so the points
 * where it hands the pure rules their inputs are pinned here, by region
 * (sourceBlock.mjs), not by line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { between, statementFrom } from './sourceBlock.mjs';
import { WATCHED_GETTERS } from './watchedConfig.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'live-refinance.mjs'), 'utf8');

describe('live-refinance wiring', () => {
  it('the settlement premise reads Diamond state only — no liquidity (r11 finding 1)', () => {
    const body = between(SRC, 'async function readSettlementPremises(', 'return { holder, inputs, ...settlementPremises(inputs) };');
    expect(body).toContain("read('getEffectiveDiscount'");
    expect(body).not.toContain('checkLiquidity');
  });

  it('the payout owner comes from the old loan READ AT THE ACCEPT BLOCK, through payoutOwnerOf (r11 finding 2)', () => {
    const region = between(SRC, 'const [oldAtPrev, oldAtFloor] = await Promise.all(', 'const payoutEvidence =');
    expect(region).toContain('loanOf(LOAN_ID, floor)');
    expect(region).toContain('storedLenderAtFloor: oldAtFloor.lender');
    expect(region).toContain("read('getUserVaultAddress', [payoutOwner], floor)");
    expect(statementFrom(SRC, 'const payoutOwner =')).toBe('const payoutOwner = PAYOUT.owner;');
  });

  it('the old loan’s status is the read pinned to the accept block (r11 finding 3)', () => {
    const region = between(SRC, '`old loan ${LOAN_ID} status == 1 (Repaid) at the accept block ${floor}`', "'oldLoanClosed.status'");
    expect(region).toContain('oldAtFloor.status === LOAN_STATUS.REPAID');
    expect(SRC).not.toMatch(/\bconfirmWrite\(/);
  });

  it('the lender review reads the request as created, not "latest" (r11 finding 3)', () => {
    expect(statementFrom(SRC, 'const reqNow =')).toBe('const reqNow = req;');
  });

  it('the risk-terms epoch is watched config, against the preflight value (r11 finding 4; one snapshot since r12)', () => {
    expect(WATCHED_GETTERS).toContain('getCurrentRiskTermsHash');
    expect(statementFrom(SRC, 'const readObservedConfig =')).toContain('readWatchedConfig(diamondRead');
    // The baseline is the WHOLE preflight snapshot, not a hand-picked subset.
    const assignments = [...SRC.matchAll(/^OBSERVED_BASELINE = (.+)$/gm)].map((m) => m[1]);
    expect(assignments).toEqual(['pre.watched;']);
  });

  it('the settlement fee inputs are the prestate snapshot, compared with the reviewed one (r12 finding 2)', () => {
    const region = between(SRC, 'const [repayDue, cfgAtPrev, tsPrev, tsAccept] = await Promise.all([', 'const S = expectedSettlement({');
    expect(region).toContain('readObservedConfig(prev)');
    expect(region).toContain('configChanges(REVIEWED_CONFIG, cfgAtPrev)');
    expect(SRC).toMatch(/const premiseBroken = settlementBlocker\(\{[^}]*\breviewDrift,/);
    expect(statementFrom(SRC, 'const REVIEWED_CONFIG =')).toBe('const REVIEWED_CONFIG = armObs.config;');
    const model = statementFrom(SRC, 'const S = expectedSettlement({');
    expect(model).toContain('lifBps: cfgAtPrev.lifBps');
    expect(model).toContain('matcherBps: cfgAtPrev.lifMatcherFeeBps');
  });

  it('the watched config is re-read immediately before the lender is armed, and a move stops the run (r11 finding 4)', () => {
    const region = between(SRC, 'const armObs = await observeConfig(', "PLAN.arm('lender');");
    expect(region).toContain('if (armObs.undetermined)');
    expect(region).toContain('raceStop(');
    // Nothing else may sit between the re-read and the arming but the anchor.
    expect(region).not.toMatch(/await (?!chainNow\(\))(?!observeConfig)/);
  });

  it('wallet and vault deltas are judged per unique address against the summed legs (r12 finding 1)', () => {
    const region = between(SRC, 'const observedOf = async (label, address) =>', "'settlement.vaults',");
    expect(region.match(/balanceDeltaMismatches\(wantTransfers, /g)).toHaveLength(2);
    expect(region).toContain("observedOf('payout vault', oldLenderVault)");
    expect(region).not.toMatch(/=== S\.(borrowerWalletDelta|lenderWalletDelta|oldLenderVaultDelta)/);
  });

  it('the replacement\u2019s fee stamps are verified against the reviewed snapshot (r12 finding 2)', () => {
    const region = between(SRC, "'replacement fee stamps equal the reviewed fees", "'replacement.feeStamps'");
    expect(region).toContain('BigInt(fresh.treasuryFeeBpsAtInit) === BigInt(REVIEWED_CONFIG.treasuryFeeBps)');
    expect(region).toContain('BigInt(fresh.loanInitiationFeeBpsAtInit) === BigInt(REVIEWED_CONFIG.lifBps)');
  });
});

