/**
 * A5 — the three gates, and what each one does when it bites.
 *
 * Sanctions screening is ON for retail once an oracle is wired; KYC and
 * country-pair gating are industrial-fork knobs that stay dormant. The
 * illiquid-asset path is neither a gate nor a refusal — it is a dual-consent
 * requirement, and the loan it produces reports NO health factor rather than
 * inventing one from a price it does not have.
 */
import { ADMIN, DIAMOND, ERC20, MOCKS, borrower, f18, lender, outsider, parseUnits, pub, rpc, tx } from '../lib/chain.mjs';
import { ABIS, approveDiamond, acceptOffer, createOffer, mint, offerParams, read } from '../lib/flow.mjs';
import { sendAs, warpDays } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { check, observe, expectRefusal, requireEnvelope } from '../lib/report.mjs';

// A stub oracle whose runtime is "return 1 for any call" — every address
// reads as sanctioned. Injected with the fork's setCode cheatcode because
// this container has no Solidity compiler; the Diamond is untouched.
const ALWAYS_SANCTIONED = '0x00000000000000000000000000000000000aaa01';
const ALWAYS_TRUE_RUNTIME = '0x600160005260206000f3';
const UNSET = '0x0000000000000000000000000000000000000000';

export async function run() {
  // Capture the deployment's OWN posture for both gates, then start from the
  // retail posture (no oracle, KYC dormant) whatever the deployment set — the
  // fixture's loan and the dormant-KYC row need it — exactly as A9 does for
  // its switch. Both are put back to the CAPTURED values afterwards, even on
  // an abort: the runner's snapshot revert also restores them, and this makes
  // the file correct on its own.
  const initialOracle = await read(ABIS.profile, 'getSanctionsOracle');
  const initialKyc = await read(ABIS.admin, 'isKYCEnforcementEnabled');
  try {
    if (initialKyc) await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.admin, functionName: 'setKYCEnforcement', args: [false] });
    if (initialOracle !== UNSET) await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.profile, functionName: 'setSanctionsOracle', args: [UNSET] });
    await runGates(initialOracle, initialKyc);
  } finally {
    await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.profile, functionName: 'setSanctionsOracle', args: [initialOracle] });
    await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.admin, functionName: 'setKYCEnforcement', args: [initialKyc] });
  }
}

async function runGates(initial, initialKyc) {
  // ------------------------------------------------------------ sanctions
  // Configuration, not a protocol property: retail is meant to wire an
  // oracle once one exists on-chain, so the starting value is observed.
  observe('A5.1', 'the deployment\'s own gate posture, before the scenario normalizes it (oracle unset = the documented fail-open window)',
    `getSanctionsOracle=${initial}${initial === UNSET ? ' (unset)' : ''} isKYCEnforcementEnabled=${initialKyc}`);

  // Open a loan BEFORE arming, so the Tier-2 close-out paths have something
  // to act on while the flag is live.
  const { loanId } = await (await import('../lib/flow.mjs')).openLoan({ lender, borrower });

  await rpc('hardhat_setCode', [ALWAYS_SANCTIONED, ALWAYS_TRUE_RUNTIME]);
  await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.profile, functionName: 'setSanctionsOracle', args: [ALWAYS_SANCTIONED] });
  const armed = await read(ABIS.profile, 'getSanctionsOracle');
  check('A5.2', 'the admin can arm the sanctions oracle', armed.toLowerCase() === ALWAYS_SANCTIONED.toLowerCase(), `oracle=${armed}`);

  const params = await offerParams({ amount: parseUnits('10', 18), collateralAmount: parseUnits('0.02', 18) });
  const tier1Create = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer', [params], lender.address);
  expectRefusal('A5.3', 'Tier-1 createOffer refuses a flagged wallet', tier1Create, 'SanctionedAddress');

  const tier1Vault = await simulate(DIAMOND, ABIS.vaultFactory, 'getOrCreateUserVault', [outsider.address], outsider.address);
  expectRefusal('A5.4', 'Tier-1 getOrCreateUserVault refuses a flagged wallet', tier1Vault, 'SanctionedAddress');

  const tier2Repay = await simulate(DIAMOND, ABIS.repay, 'repayLoan', [loanId], borrower.address);
  check('A5.5', 'Tier-2 repayLoan stays OPEN under a blanket flag, so the unflagged side can be made whole',
    tier2Repay.ok, tier2Repay.ok ? 'simulates clean' : tier2Repay.name);

  // The other Tier-2 close-out: a time-based default, driven by a caller who
  // is flagged too (the stub flags everyone). Past term + grace, with a route
  // and a funded venue, it must still go through — a regression that blocked
  // forced closes for flagged callers would strand the unflagged lender.
  await tx(outsider, { address: MOCKS.liquidToken2, abi: ERC20, functionName: 'mint', args: [MOCKS.mockSwapAdapter, parseUnits('1000000', 18)] }, 'fund venue');
  const loan = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  const graceSeconds = Number(await read(ABIS.config, 'getEffectiveGraceSeconds', [loanId]));
  await warpDays(Number(loan.durationDays) + graceSeconds / 86_400 + 1);
  const tier2Default = await simulate(DIAMOND, ABIS.defaulted, 'triggerDefault', [loanId, [{ adapterIdx: 0n, data: '0x' }]], outsider.address);
  check('A5.5b', 'Tier-2 triggerDefault stays OPEN under a blanket flag — a flagged caller can still force-close a defaulted loan',
    tier2Default.ok, tier2Default.ok ? 'simulates clean, past term + grace' : tier2Default.name);

  await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.profile, functionName: 'setSanctionsOracle', args: [UNSET] });
  // Fresh params: A5.5b warped the chain past the first set's expiry.
  const freshParams = await offerParams({ amount: parseUnits('10', 18), collateralAmount: parseUnits('0.02', 18) });
  const restored = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer', [freshParams], lender.address);
  check('A5.6', 'disarming the oracle restores permissionless access', restored.ok,
    restored.ok ? 'createOffer clean again' : restored.name);

  // ------------------------------------------------------------------ KYC
  // Retail invariant (never flipped on the retail deploy): with enforcement
  // off — which run() ensured, whatever the deployment set — both checks
  // short-circuit to true for an unverified wallet.
  const kycVerified = await read(ABIS.profile, 'isKYCVerified', [borrower.address]);
  const meetsBig = await read(ABIS.profile, 'meetsKYCRequirement', [borrower.address, parseUnits('50000', 18)]);
  check('A5.7', 'KYC enforcement is dormant on retail — the checks short-circuit true', kycVerified === true && meetsBig === true,
    `isKYCVerified=${kycVerified} meetsKYCRequirement($50k)=${meetsBig}`);

  await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.admin, functionName: 'setKYCEnforcement', args: [true] });
  check('A5.8', 'flipping the industrial-fork knob makes an unverified wallet fail the checks',
    (await read(ABIS.profile, 'isKYCVerified', [borrower.address])) === false);

  // The gate is threshold-based and binds at ACCEPT, not at offer creation.
  // The probe is a fixed $50,000-class offer; whether an unverified wallet
  // needs KYC for it is the protocol's OWN answer (`meetsKYCRequirement` at
  // the probe's live numeraire value, thresholds and all), so the envelope is
  // that answer — a deployment whose thresholds sit above the probe does not
  // run it, rather than reporting its (correct) acceptance as a failure.
  const bigParams = { amount: parseUnits('50000', 18), collateralAmount: parseUnits('60', 18) };
  const [bigPrice, bigFeedDec] = await read(ABIS.oracle, 'getAssetPrice', [MOCKS.liquidToken2]);
  const bigValue = (bigParams.amount * bigPrice) / 10n ** BigInt(bigFeedDec);
  const bigNeedsKyc = (await read(ABIS.profile, 'meetsKYCRequirement', [borrower.address, bigValue])) === false;
  const [tier0, tier1] = await read(ABIS.profile, 'getKYCThresholds');
  requireEnvelope('KYC thresholds', bigNeedsKyc,
    `the probe's ${f18(bigValue)} numeraire value needs no KYC for an unverified wallet (tier0=${f18(tier0)}, tier1=${f18(tier1)})`);
  const bigCreate = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer', [await offerParams(bigParams)], lender.address);
  await mint(lender, MOCKS.liquidToken2, '100000');
  await approveDiamond(lender, MOCKS.liquidToken2);
  await mint(borrower, MOCKS.liquidToken, '1000');
  await approveDiamond(borrower, MOCKS.liquidToken);
  const { offerId, offer } = await createOffer(lender, bigParams);
  const blockedAccept = await acceptOffer(offerId, offer, borrower, lender);
  // That the armed gate refuses the position-creating accept IS the knob's
  // purpose, so it is asserted by name.
  expectRefusal('A5.9', 'with KYC armed, accepting a $50,000 offer as an unverified wallet is refused', blockedAccept, 'KYCRequired');
  // Where the gate does NOT bind is written up as a FINDING (§4.2), not an
  // intended property — it lets a maker post an offer no taker may fill — so
  // it is observed and never certified.
  observe('A5.9b', 'with KYC armed, whether offer CREATION is gated too',
    `createOffer($50k) -> ${bigCreate.ok ? 'allowed' : bigCreate.name}`);

  await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.admin, functionName: 'setKYCEnforcement', args: [false] });
  const retailAccept = await acceptOffer(offerId, offer, borrower, lender);
  check('A5.10', 'on the retail posture the same $50,000 accept goes through', retailAccept.ok,
    retailAccept.ok ? `gas=${retailAccept.gas}` : retailAccept.reason);

  // -------------------------------------------------------------- illiquid
  const illiquid = MOCKS.illiquidToken;
  const priced = await read(ABIS.oracle, 'tryGetAssetPrice', [illiquid]);
  const illiquidStatus = await read(ABIS.oracle, 'checkLiquidity', [illiquid]);
  check('A5.11', 'an illiquid asset has no usable price and reads Illiquid',
    Array.isArray(priced) && priced[0] === false && Number(illiquidStatus) === 1,
    `tryGetAssetPrice=${JSON.stringify(priced, (_, v) => (typeof v === 'bigint' ? String(v) : v))} checkLiquidity=${illiquidStatus}`);

  await mint(borrower, illiquid, '100000');
  await approveDiamond(borrower, illiquid);
  const illiquidOffer = await createOffer(lender, {
    amount: parseUnits('100', 18),
    collateralAmount: parseUnits('5000', 18),
    collateralAsset: illiquid,
    collateralAmountMax: parseUnits('5000', 18),
  });
  const withoutConsent = await acceptOffer(illiquidOffer.offerId, illiquidOffer.offer, borrower, lender);
  expectRefusal('A5.12', 'accepting illiquid collateral WITHOUT the explicit acknowledgement is refused', withoutConsent, 'IlliquidAssetNotAcknowledged');

  const withConsent = await acceptOffer(illiquidOffer.offerId, illiquidOffer.offer, borrower, lender, {
    acknowledgedIlliquidCollateralAsset: illiquid,
  });
  check('A5.13', 'the explicit acknowledgement is the gate — with it, the accept succeeds',
    withConsent.ok, withConsent.ok ? `gas=${withConsent.gas}` : withConsent.reason);

  if (withConsent.ok) {
    const active = await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address]);
    const illiquidLoan = active[active.length - 1];
    const hf = await simulate(DIAMOND, ABIS.risk, 'calculateHealthFactor', [illiquidLoan], borrower.address);
    expectRefusal('A5.14', 'an illiquid-collateral loan reports NO health factor rather than inventing one', hf, 'IlliquidLoanNoRiskMath');
  }
}
