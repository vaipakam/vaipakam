/**
 * A5 — the three gates, and what each one does when it bites.
 *
 * Sanctions screening is ON for retail once an oracle is wired; KYC and
 * country-pair gating are industrial-fork knobs that stay dormant. The
 * illiquid-asset path is neither a gate nor a refusal — it is a dual-consent
 * requirement, and the loan it produces reports NO health factor rather than
 * inventing one from a price it does not have.
 */
import { ADMIN, DIAMOND, MOCKS, borrower, lender, outsider, parseUnits, pub, rpc } from '../lib/chain.mjs';
import { ABIS, approveDiamond, acceptOffer, createOffer, mint, offerParams, read } from '../lib/flow.mjs';
import { sendAs } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { check, observe } from '../lib/report.mjs';

// A stub oracle whose runtime is "return 1 for any call" — every address
// reads as sanctioned. Injected with the fork's setCode cheatcode because
// this container has no Solidity compiler; the Diamond is untouched.
const ALWAYS_SANCTIONED = '0x00000000000000000000000000000000000aaa01';
const ALWAYS_TRUE_RUNTIME = '0x600160005260206000f3';
const UNSET = '0x0000000000000000000000000000000000000000';

export async function run() {
  try {
    await runGates();
  } finally {
    // A5 is the only scenario that arms a global gate. Put both back even on
    // an abort — a shared fork left with a live sanctions oracle poisons
    // every later run, and the failure it produces (`SanctionedAddress` from
    // an unrelated scenario) reads like a product defect.
    await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.profile, functionName: 'setSanctionsOracle', args: [UNSET] });
    await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.admin, functionName: 'setKYCEnforcement', args: [false] });
  }
}

async function runGates() {
  // ------------------------------------------------------------ sanctions
  const initial = await read(ABIS.profile, 'getSanctionsOracle');
  // Configuration, not a protocol property: retail is meant to wire an
  // oracle once one exists on-chain, so the starting value is observed.
  observe('A5.1', 'the deployment\'s sanctions oracle before the scenario arms one (unset = the documented fail-open window)',
    `getSanctionsOracle=${initial}${initial === UNSET ? ' (unset)' : ''}`);

  // Open a loan BEFORE arming, so the Tier-2 close-out paths have something
  // to act on while the flag is live.
  const { loanId } = await (await import('../lib/flow.mjs')).openLoan({ lender, borrower });

  await rpc('hardhat_setCode', [ALWAYS_SANCTIONED, ALWAYS_TRUE_RUNTIME]);
  await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.profile, functionName: 'setSanctionsOracle', args: [ALWAYS_SANCTIONED] });
  const armed = await read(ABIS.profile, 'getSanctionsOracle');
  check('A5.2', 'the admin can arm the sanctions oracle', armed.toLowerCase() === ALWAYS_SANCTIONED.toLowerCase(), `oracle=${armed}`);

  const params = await offerParams({ amount: parseUnits('10', 18), collateralAmount: parseUnits('0.02', 18) });
  const tier1Create = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer', [params], lender.address);
  check('A5.3', 'Tier-1 createOffer refuses a flagged wallet',
    !tier1Create.ok && /Sanctioned/.test(tier1Create.name), tier1Create.ok ? 'NOT refused' : tier1Create.name);

  const tier1Vault = await simulate(DIAMOND, ABIS.vaultFactory, 'getOrCreateUserVault', [outsider.address], outsider.address);
  check('A5.4', 'Tier-1 getOrCreateUserVault refuses a flagged wallet',
    !tier1Vault.ok && /Sanctioned/.test(tier1Vault.name), tier1Vault.ok ? 'NOT refused' : tier1Vault.name);

  const tier2Repay = await simulate(DIAMOND, ABIS.repay, 'repayLoan', [loanId], borrower.address);
  check('A5.5', 'Tier-2 repayLoan stays OPEN under a blanket flag, so the unflagged side can be made whole',
    tier2Repay.ok, tier2Repay.ok ? 'simulates clean' : tier2Repay.name);

  await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.profile, functionName: 'setSanctionsOracle', args: [UNSET] });
  const restored = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer', [params], lender.address);
  check('A5.6', 'disarming the oracle restores permissionless access', restored.ok,
    restored.ok ? 'createOffer clean again' : restored.name);

  // ------------------------------------------------------------------ KYC
  // Retail invariant (never flipped on the retail deploy): with enforcement
  // off both checks short-circuit to true for an unverified wallet.
  const kycVerified = await read(ABIS.profile, 'isKYCVerified', [borrower.address]);
  const meetsBig = await read(ABIS.profile, 'meetsKYCRequirement', [borrower.address, parseUnits('50000', 18)]);
  check('A5.7', 'KYC enforcement is dormant on retail — the checks short-circuit true', kycVerified === true && meetsBig === true,
    `isKYCVerified=${kycVerified} meetsKYCRequirement($50k)=${meetsBig}`);

  await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.admin, functionName: 'setKYCEnforcement', args: [true] });
  check('A5.8', 'flipping the industrial-fork knob makes an unverified wallet fail the checks',
    (await read(ABIS.profile, 'isKYCVerified', [borrower.address])) === false);

  // The gate is threshold-based and binds at ACCEPT, not at offer creation.
  const bigParams = { amount: parseUnits('50000', 18), collateralAmount: parseUnits('60', 18) };
  const bigCreate = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer', [await offerParams(bigParams)], lender.address);
  await mint(lender, MOCKS.liquidToken2, '100000');
  await approveDiamond(lender, MOCKS.liquidToken2);
  await mint(borrower, MOCKS.liquidToken, '1000');
  await approveDiamond(borrower, MOCKS.liquidToken);
  const { offerId, offer } = await createOffer(lender, bigParams);
  const blockedAccept = await acceptOffer(offerId, offer, borrower, lender);
  // Written up as a FINDING (§4.2), not an intended property: it lets a
  // maker post an offer no taker may fill. Observed, so the ledger never
  // certifies it as correct.
  observe('A5.9', 'with KYC armed, where the gate binds (offer creation vs accept)',
    `createOffer($50k) -> ${bigCreate.ok ? 'allowed' : bigCreate.name}; acceptOffer -> ${blockedAccept.ok ? 'allowed' : blockedAccept.reason}`);

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
  check('A5.12', 'accepting illiquid collateral WITHOUT the explicit acknowledgement is refused',
    !withoutConsent.ok, withoutConsent.ok ? 'accepted without consent' : withoutConsent.reason);

  const withConsent = await acceptOffer(illiquidOffer.offerId, illiquidOffer.offer, borrower, lender, {
    acknowledgedIlliquidCollateralAsset: illiquid,
  });
  check('A5.13', 'the explicit acknowledgement is the gate — with it, the accept succeeds',
    withConsent.ok, withConsent.ok ? `gas=${withConsent.gas}` : withConsent.reason);

  if (withConsent.ok) {
    const active = await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address]);
    const illiquidLoan = active[active.length - 1];
    const hf = await simulate(DIAMOND, ABIS.risk, 'calculateHealthFactor', [illiquidLoan], borrower.address);
    check('A5.14', 'an illiquid-collateral loan reports NO health factor rather than inventing one',
      !hf.ok, hf.ok ? `returned ${hf.result}` : hf.name);
  }
}
