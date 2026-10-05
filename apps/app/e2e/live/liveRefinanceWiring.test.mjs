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
    expect(statementFrom(SRC, 'const reqNow =')).toBe('const reqNow = REQUEST_AS_CREATED;');
    expect(SRC).toContain('  REQUEST_AS_CREATED = req;');
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
    expect(SRC).toMatch(/^ {2}REVIEWED_CONFIG = armObs\.config;$/m);
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

  it('the preflight evaluates the supported loan posture, and blocks on any miss (r13 finding 1)', () => {
    const region = between(SRC, 'for (const m of postureMisses(loan)) {', 'if (postureMisses(loan).length === 0)');
    expect(region).toContain('want(`loan ${m.field} within the supported posture');
    expect(region).toContain(', false, m.value);');
  });

  it('the preflight\u2019s open-request scan IS the ledger\u2019s, cancellation included (r13 finding 2)', () => {
    expect(statementFrom(SRC, 'const openRequests =')).toBe('const openRequests = await openRequestsAt(head);');
    expect(between(SRC, 'async function requestStateAt(', 'async function openRequestsAt(')).toContain('requestStateOf({ offer, cancelled, blockTs: block.timestamp })');
  });

  it('an external fill during the Offer Book wait goes through externalFillVerdict to raceStop (r13 finding 3)', () => {
    const region = between(SRC, "if (fundLink === 'taken') {", 'raceStop(fill.why);');
    expect(region).toContain('externalFillVerdict({ requestId, replacement, scanError })');
    expect(region).toContain("if (fill.kind === 'fail') stop(fill.why);");
    expect(region).toContain('replacementAt(');
  });

  it('the stored expiry is compared exactly with the decoded submission, clamped (r13 finding 4)', () => {
    const region = between(SRC, 'const createInput = (await pub.getTransaction({ hash: createTx.hash })).input;', "request expiry is exactly the submitted expiry");
    expect(region).toContain('decodeFunctionData({ abi: DIAMOND_ABI, data: createInput }).args[0].expiresAt');
    expect(region).toContain('expectedStoredExpiry({');
    expect(SRC).toMatch(/BigInt\(req\.expiresAt\) === wantExpiry/);
  });

  // ---- #2422 r14 ROOT A — one post-write failure classifier ----
  // The post-write try body: from the session hand-off to its only catch.
  const TRY_BODY = between(SRC, 'const bp = session.page;', 'await settleFailure(err);');

  it('ROOT A: the post-write try has ONE catch, and it only settles through the classifier', () => {
    const tail = between(SRC, "await session?.shot('refinance-zz-stopped');", '} finally {');
    expect(tail).toContain('await settleFailure(err);');
    expect(tail).not.toMatch(/exitCode\s*=|process\.exit\(|RACE_STOP\s*=/);
    expect(between(SRC, 'async function settleFailure(err) {', '\n}\n')).toContain('classifyPostWriteFailure({ cause: { kind, why }, ours, premises })');
  });

  it('ROOT A: no post-write stop can bypass the catch — no exit, exit code or nested catch-all in the try body', () => {
    expect(TRY_BODY.length).toBeGreaterThan(5_000); // not-a-source-region: a size floor proving the region is the whole try body, not a bound
    expect(TRY_BODY).not.toMatch(/process\.exit\(/);
    expect(TRY_BODY).not.toMatch(/\bexitCode\s*=/);
    expect(TRY_BODY).not.toMatch(/blockedBeforeAnyWrite\(/);
    // The two outcome verifiers are called from the try AND from the classifier.
    expect(TRY_BODY).toContain('await verifyCreateOutcome(pageRequestId);');
    expect(TRY_BODY).toContain('await verifyAcceptOutcome();');
  });

  it('ROOT A (i): a mined transaction is verified by the same function the happy path runs, with the UI failure recorded', () => {
    const settle = between(SRC, 'async function settleFailure(err) {', '\n}\n');
    expect(settle).toContain("if (accept) await verifyAcceptOutcome();");
    expect(settle).toContain('else await verifyCreateOutcome(null);');
    expect(settle).toMatch(/if \(POST_WRITE\.recordUiFailure\) \{\s*check\(/);
  });

  it('ROOT A (ii): premises re-read = the whole snapshot (screening included), the request state, the loan posture', () => {
    const p = between(SRC, 'async function premisesNow({ acceptMined }) {', '\n}\n');
    expect(p).toContain('readObservedConfig(head)');
    expect(p).toContain('configChanges(REVIEWED_CONFIG ?? OBSERVED_BASELINE, cfg)');
    expect(p).toContain('requestStateAt(REQUEST_ID, head)');
    expect(p).toContain('replacementAt(head)');
    expect(p).toContain('postureMisses(await loanOf(LOAN_ID, head))');
    const ctx = between(SRC, 'const watchedContextOf = (l, oldHolder) => ({', '});');
    expect(ctx).toContain('participants: { borrower: BORROWER, lender: LENDER');
  });

  it('ROOT A (iii): the request state is re-read before the lender is armed, and a non-open request stops', () => {
    const region = between(SRC, 'const stateBeforeArm = await requestStateAt(', "PLAN.arm('lender');");
    expect(region).toContain("if (stateBeforeArm !== 'open') stop(");
  });

  // ---- #2422 r14 ROOT B — the replacement through the declared mapping ----
  it('ROOT B: replacement.loan is ONE evaluation of the whole mapping, with the unchecked fields in NOT VERIFIED', () => {
    const verify = between(SRC, 'async function verifyAcceptOutcome() {', '\n}\n');
    expect(verify).toContain('evaluateReplacement(fresh, {');
    expect(verify.match(/'replacement\.loan'/g)).toHaveLength(1);
    expect(verify).toContain('terms: signedTerms');
    expect(SRC).toContain("id: 'replacementUncheckedFields'");
  });
});

