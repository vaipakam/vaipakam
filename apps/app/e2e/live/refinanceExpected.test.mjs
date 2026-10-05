/**
 * #2422 r2 — the complete expected payloads `live-refinance.mjs` arms its
 * write gate with. The live drive's happy path cannot exercise a refusal,
 * so the refusals that matter are pinned here: the Full VPFI tariff on the
 * signed acceptance terms, a field the builders do not name, and an accept
 * call whose terms differ from the ones signed.
 *
 * The fixture is loan 22 → request #45 as it really ran on Base Sepolia on
 * 2026-10-05; the same builders were checked against those transactions'
 * calldata with zero mismatches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { structMismatches } from './expectedPayload.mjs';
import {
  acceptTermsTypes,
  decodeTxForComparison,
  expectedAcceptOfferCall,
  expectedAcceptTerms,
  expectedAcceptTypedData,
  expectedCreateOfferCall,
  expectedTx,
  ZERO_HASH,
} from './refinanceExpected.mjs';
import { encodeFunctionData } from 'viem';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ABI = JSON.parse(
  fs.readFileSync(path.join(HERE, '../../../../packages/contracts/src/diamondAbi.json'), 'utf8'),
);
const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const LENDER = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
const BORROWER = '0xC86BB89f8ddF703c34724Cf11137498bC69F039D';
const NOW = 1_791_190_612n;
const LOAN = {
  principalAsset: '0x4200000000000000000000000000000000000006',
  collateralAsset: '0xF2c65Cd941FE681B575Adc8DFc155Bf612675037',
  principal: 5_000_000_000_000_000n,
  collateralAmount: 10n ** 20n,
  collateralTokenId: 0n,
  collateralQuantity: 0n,
  collateralAssetType: 0,
  prepayAsset: '0x4200000000000000000000000000000000000006',
  useFullTermInterest: true,
  allowsPartialRepay: false,
};
const TERMS_ARGS = {
  loan: LOAN,
  loanId: 22n,
  requestId: 45n,
  lender: LENDER,
  borrower: BORROWER,
  rateBps: 1200n,
  days: 30n,
  riskTermsHash: ZERO_HASH,
  nowSec: () => NOW,
};

/** The acceptance terms request #45 was actually signed with. */
function signedTerms(over = {}) {
  const t = expectedAcceptTerms({ ...TERMS_ARGS, pinned: { nonce: 7n, deadline: NOW + 1_800n } });
  return { ...t, ...over };
}

describe('refinanceExpected — complete payloads, closed in both directions', () => {
  it('reads the AcceptTerms field list from the ABI, Full-tariff trio last', () => {
    const types = acceptTermsTypes(ABI);
    expect(types).toHaveLength(34);
    const names = types.map((t) => t.name);
    expect([names.at(-3), names.at(-2), names.at(-1)]).toEqual([
      'acceptorFull',
      'acceptorMaxCStar',
      'acceptorAllowFullDowngrade',
    ]);
    // Every expected-terms field is a typed field and vice versa.
    expect(Object.keys(expectedAcceptTerms(TERMS_ARGS)).sort()).toEqual(types.map((t) => t.name).sort());
  });

  it('accepts the genuine signed terms and refuses a Full-tariff opt-in', () => {
    const expected = expectedAcceptTerms(TERMS_ARGS);
    expect(structMismatches(expected, signedTerms())).toEqual([]);
    expect(
      structMismatches(expected, signedTerms({ acceptorFull: true, acceptorMaxCStar: 10n, acceptorAllowFullDowngrade: true })),
    ).toEqual([
      'acceptorFull: true (want false)',
      'acceptorMaxCStar: 10n (want 0)',
      'acceptorAllowFullDowngrade: true (want false)',
    ]);
  });

  it('refuses typed data carrying a field the terms do not define', () => {
    const exp = expectedAcceptTypedData({ abi: ABI, chainId: 84532, diamond: DIAMOND, signer: LENDER, terms: expectedAcceptTerms(TERMS_ARGS) });
    const typedData = {
      domain: { name: 'Vaipakam AcceptOffer', version: '1', chainId: 84532, verifyingContract: DIAMOND },
      types: { AcceptTerms: acceptTermsTypes(ABI) },
      primaryType: 'AcceptTerms',
      message: { ...signedTerms(), extra: '1' },
    };
    expect(structMismatches(exp, { signer: LENDER, typedData })).toEqual(['typedData.message.extra: unexpected field "1"']);
  });

  it('binds the accept CALL to exactly the signed terms and signature', () => {
    const signed = signedTerms();
    const sig = `0x${'ab'.repeat(65)}`;
    const exp = expectedTx({
      from: LENDER,
      to: DIAMOND,
      call: expectedAcceptOfferCall({ requestId: 45n, terms: signed, signature: sig }),
      chainId: 84532,
    });
    const encode = (terms, signature) => ({
      from: LENDER,
      to: DIAMOND,
      data: encodeFunctionData({ abi: ABI, functionName: 'acceptOffer', args: [45n, terms, signature] }),
    });
    const abiFor = () => ABI;
    expect(structMismatches(exp, decodeTxForComparison(encode(signed, sig), abiFor))).toEqual([]);
    expect(
      structMismatches(exp, decodeTxForComparison(encode({ ...signed, nonce: 8n }, sig), abiFor)),
    ).toEqual(['data.args.terms.nonce: 8n (want 7)']);
    // An envelope field the expected request does not name is refused too.
    expect(
      structMismatches(exp, { ...decodeTxForComparison(encode(signed, sig), abiFor), accessList: [] }),
    ).toEqual(['accessList: unexpected field []']);
  });

  it('builds the createOffer request over all 26 params, with the 0..ceiling band', () => {
    const call = expectedCreateOfferCall({ loan: LOAN, loanId: 22n, rateBps: 1200n, days: 30n, nowSec: () => NOW });
    const fn = ABI.find((e) => e.type === 'function' && e.name === 'createOffer');
    expect(Object.keys(call.args.params).sort()).toEqual(fn.inputs[0].components.map((c) => c.name).sort());
    expect(call.args.params.interestRateBps).toBe(0n);
    expect(call.args.params.interestRateBpsMax).toBe(1200n);
  });
});
