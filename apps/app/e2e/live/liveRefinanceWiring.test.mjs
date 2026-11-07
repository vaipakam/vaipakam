/**
 * The driver-side wiring that the pure modules cannot see (#2422 r11,
 * narrowed in the #2431 re-cut). `live-refinance.mjs` runs only against the
 * live chain, so the points where it hands the pure rules their inputs are
 * pinned here, by region (sourceBlock.mjs), not by line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { OUTCOME_CLAIMS } from './outcomeManifest.mjs';
import { LIEN_FIELDS } from './refinanceOutcome.mjs';
import { between, blockFrom, statementFrom } from './sourceBlock.mjs';
import { WATCHED_GETTERS } from './watchedConfig.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'live-refinance.mjs'), 'utf8');
const VERIFY = blockFrom(SRC, 'async function verifyAcceptOutcome() {');
const SETTLE = blockFrom(SRC, 'async function settleFailure(err) {');

describe('live-refinance wiring — what the drive claims (#2431 re-cut)', () => {
  it('the manifest verifies exactly the three outcome claims plus the write discipline', () => {
    const verifiable = between(SRC, '  verifiable: [', '  notVerified: [');
    const ids = [...verifiable.matchAll(/^ {6}id: '(\w+)',$/gm)].map((m) => m[1]);
    expect(ids).toEqual([...OUTCOME_CLAIMS, 'writeDiscipline']);
    // The settlement amounts are stated as NOT verified, with their coverage.
    const notVerified = between(SRC, '  notVerified: [', '\n});');
    expect(notVerified).toContain("id: 'settlementAmounts'");
    expect(notVerified).toContain('contracts/test/fork/RefinanceIlliquidLiveForkTest.t.sol');
  });

  it('the deleted settlement and mapping machinery is not reintroduced', () => {
    for (const gone of [
      'settlementBlocker',
      'readSettlementPremises',
      'payoutOwnerOf',
      'balanceDeltaMismatches',
      'txIsolation',
      'replacementMapping',
      'postWriteFailure',
      'classifyPostWriteFailure',
      'externalFillVerdict',
      'expectedSettlement',
    ]) {
      expect(SRC, gone).not.toContain(gone);
    }
  });
});

describe('live-refinance wiring — the three outcome claims', () => {
  it('every chain read in the outcome verifier is pinned to the accept block', () => {
    const reads = [...VERIFY.matchAll(/\b(?:read|loanOf)\(([^()]*)\)/g)].map((m) => m[1]);
    expect(reads.length).toBeGreaterThanOrEqual(5);
    expect(reads.filter((args) => !/, floor$/.test(args))).toEqual([]);
    expect(statementFrom(VERIFY, 'const floor =')).toBe('const floor = acc.blockNumber;');
  });

  it('oldLoanClosed: the old loan read at the accept block must be Repaid', () => {
    expect(VERIFY).toContain('loanOf(LOAN_ID, floor)');
    const region = between(VERIFY, 'check(`loan ${LOAN_ID} is Repaid', "'oldLoanClosed.status'");
    expect(region).toContain('oldAtFloor.status === LOAN_STATUS.REPAID');
  });

  it('replacementOpened: one id from the receipt events, and that loan Active for the same borrower and our lender', () => {
    expect(VERIFY).toContain("e.eventName === 'OfferAccepted' && e.args.offerId === requestId");
    expect(VERIFY).toContain("e.eventName === 'LoanRefinanced' && e.args.oldLoanId === LOAN_ID");
    const events = between(VERIFY, "'the accept receipt names exactly one replacement", "'replacementOpened.events'");
    expect(events).toContain('decoded.undecodable === 0 && accepted.length === 1 && refinanced.length === 1 && ids.length === 1');
    const loan = between(VERIFY, '`replacement loan ${newLoanId} is Active', "'replacementOpened.loan'");
    expect(loan).toContain('fresh.status === LOAN_STATUS.ACTIVE && eq(fresh.borrower, loan.borrower) && eq(fresh.lender, LENDER)');
  });

  it('collateralLienCarried: both liens through lienCarried against the old loan’s collateral, and no collateral out of the vault', () => {
    const lien = statementFrom(VERIFY, 'const lienDiff = lienCarried({');
    expect(lien).toContain('oldAfter: oldLienAfter');
    expect(lien).toContain('newAfter: newLien');
    expect(lien).toContain('user: loan.borrower, asset: loan.collateralAsset, assetType: loan.collateralAssetType, tokenId: loan.collateralTokenId, amount: loan.collateralAmount');
    expect(between(VERIFY, '`the collateral lien moved', "'collateralLienCarried.liens'")).toContain('lienDiff.length === 0');
    const out = statementFrom(VERIFY, 'const out = collateralMovedOut({');
    expect(out).toContain('logs: acc.logs, token: loan.collateralAsset, from: borrowerVault');
    expect(VERIFY).toContain("read('getUserVaultAddress', [BORROWER], floor)");
    expect(between(VERIFY, "check('the accept receipt moves no collateral", "'collateralLienCarried.noCollateralOut'")).toContain('out.length === 0');
  });

  it('every old-lien field lienCarried does not compare is named under NOT VERIFIED (#2434 r1 P1)', () => {
    const entry = between(SRC, "id: 'oldLienTombstone',", 'coveredBy:');
    const fields = Object.keys(LIEN_FIELDS.old.notVerified);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(entry, f).toMatch(new RegExp(`\\b${f}\\b`));
    // The replacement side leaves nothing unverified.
    expect(Object.keys(LIEN_FIELDS.replacement.notVerified)).toEqual([]);
  });
});

describe('live-refinance wiring — one failure rule', () => {
  // The post-write try body: from the session hand-off to its only catch.
  const TRY_BODY = between(SRC, 'const bp = session.page;', 'await settleFailure(err);');

  it('the try has ONE catch, and it settles only through settleFailure', () => {
    const tail = between(SRC, "await session?.shot('refinance-zz-stopped');", '} finally {');
    expect(tail).toContain('await settleFailure(err);');
    expect(tail).not.toMatch(/exitCode\s*=|process\.exit\(/);
  });

  it('no stop can bypass the catch — no exit, exit code or BLOCKED exit in the try body', () => {
    expect(TRY_BODY.length).toBeGreaterThan(5_000); // not-a-source-region: a size floor proving the region is the whole try body, not a bound
    expect(TRY_BODY).not.toMatch(/process\.exit\(/);
    expect(TRY_BODY).not.toMatch(/\bexitCode\s*=/);
    expect(TRY_BODY).not.toMatch(/blockedBeforeAnyWrite\(/);
    expect(TRY_BODY).toContain('await verifyAcceptOutcome();');
  });

  it('settleFailure: FAIL only before a write; after one it records the stop and verifies a MINED accept', () => {
    const preWrite = blockFrom(SETTLE, 'if (!anythingAllowed()) {');
    expect(preWrite).toContain('exitCode = 1;');
    expect(SETTLE.match(/\bexitCode\s*=/g)).toHaveLength(1);
    expect(SETTLE).toContain('STOPPED = why;');
    expect(SETTLE).toContain("if (!ACCEPT_VERIFIED && (await ourStepMined('l-accept'))) {");
    expect(blockFrom(SETTLE, "if (!ACCEPT_VERIFIED && (await ourStepMined('l-accept'))) {")).toContain('await verifyAcceptOutcome();');
  });

  it('the exit is runVerdict’s, fed the stop, the write state and the nonce gate-escape', () => {
    const v = statementFrom(SRC, 'const VERDICT = runVerdict({');
    expect(v).toContain('rows: MANIFEST.rows()');
    expect(v).toContain('wrote: anythingAllowed()');
    expect(v).toContain('stopped: STOPPED');
    expect(v).toContain('preWriteFailure: exitCode !== 0');
    expect(v).toContain('gateEscape: reconciliation.escaped');
    expect(statementFrom(SRC, 'const reconciliation =')).toBe('const reconciliation = await report(baselineNonces);');
    expect(SRC).toContain('if (VERDICT.exit !== 0) await reportAfterFailure();');
    expect(SRC.trimEnd().endsWith('process.exit(VERDICT.exit);')).toBe(true);
  });

  it('a request filled by another party is a stop (UNDETERMINED), never a verdict of its own', () => {
    expect(statementFrom(SRC, "if (fundLink === 'taken')")).toMatch(/^if \(fundLink === 'taken'\) stop\(/);
  });
});

describe('live-refinance wiring — the app names the request it created (#2434 r2)', () => {
  it('the "is live" banner id is compared with the receipt id, filed under requestIdentity, and a mismatch stops at once', () => {
    const region = between(SRC, '  await pinRequestFromReceipt();', "await closeSession('borrower');");
    const guard = blockFrom(region, 'if (');
    expect(guard).toContain('BigInt(live) === requestId');
    expect(guard).toContain("'requestIdentity.banner'");
    expect(guard).toMatch(/\)\s*\{\s*stop\(/);
    // The banner's N is the digits the poll captured, nothing else.
    expect(SRC).toContain('const m = t.match(/Refinance request #(\\d+) is live/i);');
    // A mismatch is a contradiction (FAIL), not merely a stop (UNDETERMINED).
    expect(OUTCOME_CLAIMS).toContain('requestIdentity');
  });
});

describe('live-refinance wiring — pre-write gates', () => {
  it('the watched config is re-read immediately before the BORROWER is armed; a move is BLOCKED', () => {
    const region = between(SRC, "beforeWriteStep('posting the refinance request');", "PLAN.arm('borrower');");
    expect(region).toContain('const bArmObs = await observeConfig(');
    expect(region).toContain('if (bArmObs.undetermined) stop(');
    // Nothing else may sit between the re-read and the arming but the anchor.
    expect(region).not.toMatch(/await (?!chainNow\(\))(?!observeConfig)/);
    // Before any write, observeConfig's race is BLOCKED (exits, writes nothing).
    expect(blockFrom(SRC, 'async function observeConfig(what, observe) {')).toContain(
      "if (v.action === 'blocked') await blockedByRace(",
    );
  });

  it('the lender review reads the request as created at its create block, not "latest"', () => {
    expect(statementFrom(SRC, 'const reqNow =')).toBe('const reqNow = REQUEST_AS_CREATED;');
    expect(statementFrom(SRC, 'REQUEST_AS_CREATED = await')).toBe(
      "REQUEST_AS_CREATED = await read('getOfferDetails', [requestId], createRcpt.blockNumber);",
    );
  });

  it('the risk-terms epoch is watched config, against the whole preflight snapshot', () => {
    expect(WATCHED_GETTERS).toContain('getCurrentRiskTermsHash');
    expect(statementFrom(SRC, 'const readObservedConfig =')).toContain('readWatchedConfig(diamondRead');
    const assignments = [...SRC.matchAll(/^OBSERVED_BASELINE = (.+)$/gm)].map((m) => m[1]);
    expect(assignments).toEqual(['pre.watched;']);
  });

  it('a race on the lender review stops before the consent tick', () => {
    expect(between(SRC, 'const lObs = await observeConfig(', "beforeWriteStep('ticking the lender consent');")).toContain(
      'if (lObs.undetermined) stop(',
    );
  });

  it('the request state and the watched config are re-read immediately before the lender is armed', () => {
    const region = between(SRC, 'const stateBeforeArm = await requestStateAt(', "PLAN.arm('lender');");
    expect(region).toContain("if (stateBeforeArm !== 'open') stop(");
    expect(region).toContain('if (armObs.undetermined) stop(');
    // Nothing else may sit between the config re-read and the arming but the anchor.
    const tail = between(SRC, 'const armObs = await observeConfig(', "PLAN.arm('lender');");
    expect(tail).not.toMatch(/await (?!chainNow\(\))(?!observeConfig)/);
  });

  it('the preflight evaluates the supported loan posture, and blocks on any miss', () => {
    const region = between(SRC, 'for (const m of postureMisses(loan)) {', 'if (postureMisses(loan).length === 0)');
    expect(region).toContain('want(`loan ${m.field} within the supported posture');
    expect(region).toContain(', false, m.value);');
  });

  it('the preflight’s open-request scan IS the ledger’s, cancellation included', () => {
    expect(statementFrom(SRC, 'const openRequests =')).toBe('const openRequests = await openRequestsAt(head);');
    expect(between(SRC, 'async function requestStateAt(', 'async function openRequestsAt(')).toContain(
      'requestStateOf({ offer, cancelled, blockTs: block.timestamp })',
    );
  });

  it('every participant is screened in the watched snapshot', () => {
    const ctx = between(SRC, 'const watchedContextOf = (l, oldHolder) => ({', '});');
    expect(ctx).toContain('participants: { borrower: BORROWER, lender: LENDER');
  });
});

describe('live-refinance wiring — the payoff-permit route (#3295)', () => {
  it('the preflight BLOCKS a Diamond that does not route the payoff permit, from the watched routing', () => {
    expect(statementFrom(SRC, 'const payoffRoute =')).toBe(
      "const payoffRoute = /^0x0{40}$/i.test(watched.payoffPermitHost) ? 'approval' : 'permit';",
    );
    const want = between(SRC, 'want(\n  \'the Diamond pays the refinance payoff', 'PERMIT_NEEDED =');
    expect(want).toContain("pre.payoffRoute === 'permit',");
    expect(statementFrom(SRC, 'PERMIT_NEEDED = pre.')).toBe('PERMIT_NEEDED = pre.walletShare !== null && pre.walletShare > 0n;');
  });

  it('the plan is built with the permit getters the gate fills', () => {
    const plan = statementFrom(SRC, 'PLAN = createWritePlan(');
    expect(plan).toContain('permitNeeded: PERMIT_NEEDED,');
    expect(plan).toContain('permit2ShareBounds: () => PERMIT2_SHARE_BOUNDS,');
    expect(plan).toContain('borrowerPermit: () => BORROWER_PERMIT,');
    expect(plan).toContain("st.id === 'b-permit' && st.status === 'consumed'");
  });

  it('the borrower gate reads the permit figures BEFORE the synchronous judgement, and the judgement keeps the decoded call', () => {
    const gate = blockFrom(SRC, 'function signingGateFor(role) {');
    const prep = gate.indexOf("if (role === 'borrower') await prepareBorrowerPermit();");
    expect(prep).toBeGreaterThan(-1);
    expect(prep).toBeLessThan(gate.indexOf('const v = judge(role, method, params);'));
    expect(blockFrom(SRC, 'function judge(role, method, params) {')).toContain("{ call: actual.data }");
  });

  it('the permit figures come from the contract: the receipt’s request, the createOffer’s own expiry, the share at that deadline', () => {
    const prep = blockFrom(SRC, 'async function prepareBorrowerPermit() {');
    expect(prep).toContain("const expiresAt = create.record.call?.args?.params?.expiresAt;");
    expect(prep).toContain('const deadline = lastFillableMoment(BigInt(expiresAt), GRACE_END);');
    expect(prep).toContain('const maxAmount = await walletShareBy(deadline, rcpt.blockNumber);');
    expect(prep).toContain('BORROWER_PERMIT = { offerId: created[0].args.offerId, deadline, maxAmount };');
    expect(blockFrom(SRC, 'async function walletShareBy(by, blockNumber) {')).toContain(
      "read('getRefinancePayoff', [LOAN_ID, 0n, by], blockNumber)",
    );
  });

  it('the borrower stays armed until the page reports the permit attached, and the attach step was consumed', () => {
    const region = between(SRC, "stop(`the refinance request did not go live: ${live ?? 'timed out'}`);", "PLAN.close();\n  console.log('info  write plan CLOSED after the borrower");
    expect(region).toContain('if (PERMIT_NEEDED) {');
    expect(region).toContain('if (t.includes(squash(P.done))) return \'attached\';');
    expect(region).toContain("if (permitOutcome !== 'attached') stop(");
    expect(region).toContain("st.id === 'b-attach'");
  });

  it('the attached permit is read back before the lender is armed', () => {
    expect(blockFrom(SRC, 'async function pinRequestFromReceipt() {')).toContain('if (PERMIT_NEEDED) await verifyAttachedPermit();');
    const verify = blockFrom(SRC, 'async function verifyAttachedPermit() {');
    expect(verify).toContain("read('getRefinancePayoff', [LOAN_ID, requestId, BORROWER_PERMIT.deadline])");
    expect(verify).toContain('nonceSpent === false');
    expect(verify).toContain('maxAmount >= shareBy');
    expect(verify).toMatch(/if \(!ok\) stop\(/);
  });

  it('the borrower review is compared with the contract’s figures and the card’s wallet-steps note', () => {
    expect(statementFrom(SRC, 'const bTerms =')).toBe(
      'const bTerms = await borrowerReviewMismatches(bObs.observed, bObs.config, receiptText);',
    );
    expect(blockFrom(SRC, 'async function borrowerReviewMismatches(rows, config, cardText) {')).toContain(
      "read('getRefinancePayoff', [LOAN_ID, 0n, lastFillable])",
    );
  });

  it('the ledger watches the borrower’s Permit2 allowance, and no step touches its Diamond allowance', () => {
    const ledger = between(SRC, 'const LEDGER = [', '\n];');
    expect(ledger).toContain("touchedBy: ['b-permit2-reset', 'b-permit2-set', 'l-accept', 'b-request-filled'],");
    expect(ledger).toContain('read: (head) => allowanceAt(BORROWER, PERMIT2_ADDRESS, head),');
    expect(between(SRC, "key: 'borrowerDiamondAllowance',", 'restore: () => null,')).toContain('touchedBy: [],');
  });
});
