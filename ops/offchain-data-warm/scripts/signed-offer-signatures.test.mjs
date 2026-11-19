// #2899 — the restore re-applies the indexer route's signature rule to every
// archived signed order. Signed here with a throwaway key generated per run,
// through the wallet's own typed-data path, so the check is held to what a
// maker actually signs rather than to a copy of the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { NO_COLLECTION, canonicalOrderJson, canonicalPlacementJson, signedOfferColumns } from '../../../packages/lib/src/signedOfferWire.mjs';
import {
  SIGNED_OFFER_SET_TYPES,
  SIGNED_OFFER_TYPES,
  signedOfferDomain,
  signedOfferMessage,
} from '../../../packages/lib/src/signedOfferCrypto.mjs';
import {
  bundleDiamonds,
  committedDiamonds,
  signedOfferSignatureProblem,
  signedOfferVerdicts,
  verdictKey,
} from './lib/signed-offer-signatures.mjs';
import { hashStruct } from 'viem';

const CHAIN = 84532;
const DIAMOND = `0x${'7'.repeat(40)}`;
const OTHER_DIAMOND = `0x${'8'.repeat(40)}`;
const diamonds = new Map([[CHAIN, DIAMOND]]);
const account = privateKeyToAccount(generatePrivateKey());
const signer = account.address.toLowerCase();

function order(over = {}) {
  return {
    offerType: '0', lendingAsset: `0x${'1'.repeat(40)}`, amount: '1000', amountMax: '0',
    interestRateBps: '500', interestRateBpsMax: '0', collateralAsset: `0x${'2'.repeat(40)}`,
    collateralAmount: '2000', collateralAmountMax: '0', durationDays: '30', assetType: '0',
    collateralAssetType: '0', tokenId: '0', quantity: '0', collateralTokenId: '0',
    collateralQuantity: '0', prepayAsset: `0x${'0'.repeat(40)}`, allowsPartialRepay: true,
    allowsPrepayListing: false, allowsParallelSale: false, expiresAt: '0', fillMode: '0',
    periodicInterestCadence: '0', refinanceTargetLoanId: '0', useFullTermInterest: false,
    lifecycleFlex: '0', integrator: `0x${'0'.repeat(40)}`,
    creatorFull: false, creatorMaxCStar: '0', creatorAllowFullDowngrade: false,
    maxTreasuryFeeBps: '200', maxLoanInitiationFeeBps: '20',
    allowedTaker: `0x${'0'.repeat(40)}`, coSigner: `0x${'0'.repeat(40)}`,
    signer, nonce: '0', deadline: '0',
    ...NO_COLLECTION,
    ...over,
  };
}
const hashOf = (o) => hashStruct({ data: signedOfferMessage(o), primaryType: 'SignedOffer', types: SIGNED_OFFER_TYPES });

function row(o, signature, over = {}) {
  return {
    chain_id: CHAIN, order_hash: hashOf(o), order_json: canonicalOrderJson(o), signature,
    ...signedOfferColumns(o), status: 'active', filled_amount: '0', created_at: 1, updated_at: 1, offer_set: null,
    ...over,
  };
}
const signAlone = (o, verifyingContract = DIAMOND) =>
  account.signTypedData({
    domain: signedOfferDomain(CHAIN, verifyingContract),
    types: SIGNED_OFFER_TYPES,
    primaryType: 'SignedOffer',
    message: signedOfferMessage(o),
  });

test('an order signed alone by its signer on that Diamond passes', async () => {
  const o = order();
  assert.equal(await signedOfferSignatureProblem(row(o, await signAlone(o)), diamonds), null);
});

test('an order signed as one of a set passes with its placement, and only with it', async () => {
  const a = order();
  const b = order({ amount: '2000' });
  const signature = await account.signTypedData({
    domain: signedOfferDomain(CHAIN, DIAMOND),
    types: SIGNED_OFFER_SET_TYPES,
    primaryType: 'SignedOfferSet',
    message: { offers: [signedOfferMessage(a), signedOfferMessage(b)] },
  });
  const placementOfB = canonicalPlacementJson({ others: [hashOf(a)], index: 1 });
  assert.equal(await signedOfferSignatureProblem(row(b, signature, { offer_set: placementOfB }), diamonds), null);
  // The same signature read as signed alone, or at the wrong index, fails.
  assert.match(await signedOfferSignatureProblem(row(b, signature), diamonds), /does not recover the signer/);
  const wrongIndex = canonicalPlacementJson({ others: [hashOf(a)], index: 0 });
  assert.match(await signedOfferSignatureProblem(row(b, signature, { offer_set: wrongIndex }), diamonds), /does not recover/);
});

test('a forged, altered, re-keyed or foreign-chain row fails, each for its reason', async () => {
  const o = order();
  const sig = await signAlone(o);
  // Signed by someone else for this signer.
  const stranger = privateKeyToAccount(generatePrivateKey());
  const forged = await stranger.signTypedData({
    domain: signedOfferDomain(CHAIN, DIAMOND), types: SIGNED_OFFER_TYPES, primaryType: 'SignedOffer', message: signedOfferMessage(o),
  });
  assert.match(await signedOfferSignatureProblem(row(o, forged), diamonds), /does not recover the signer/);
  // Signed for another Diamond (a retired deployment): unfillable on this one.
  assert.match(await signedOfferSignatureProblem(row(o, await signAlone(o, OTHER_DIAMOND)), diamonds), /does not recover/);
  // The order changed after signing, its hash recomputed to match.
  const altered = order({ interestRateBps: '100' });
  assert.match(await signedOfferSignatureProblem(row(altered, sig), diamonds), /does not recover/);
  // The row filed under a hash that is not the order's.
  assert.match(
    await signedOfferSignatureProblem(row(o, sig, { order_hash: `0x${'b'.repeat(64)}` }), diamonds),
    /order_hash is not the struct hash/,
  );
  // A chain this build has no Diamond for.
  assert.match(await signedOfferSignatureProblem(row(o, sig, { chain_id: 1 }), diamonds), /no Diamond in this build/);
  // Garbage signature bytes are a failure, not a throw.
  assert.match(await signedOfferSignatureProblem(row(o, `0x${'0'.repeat(130)}`), diamonds), /does not recover/);
});

test('signedOfferVerdicts files a verdict per archived row under its key', async () => {
  const o = order();
  const good = row(o, await signAlone(o));
  const bad = row(order({ nonce: '1' }), await signAlone(o));
  const verdicts = await signedOfferVerdicts(
    { d1: { archive: [{ name: 'user_thresholds', rows: [] }, { name: 'signed_offers', rows: [good, bad] }] } },
    diamonds,
  );
  assert.equal(verdicts.size, 2);
  assert.equal(verdicts.get(verdictKey(CHAIN, good.order_hash)), null);
  assert.match(verdicts.get(verdictKey(CHAIN, bad.order_hash)), /does not recover/);
  assert.equal((await signedOfferVerdicts({ d1: { archive: [] } }, diamonds)).size, 0);
});

test('the Diamonds come from the deployment bundle the indexer reads', () => {
  const committed = committedDiamonds();
  assert.ok(committed.size > 0);
  for (const [chainId, diamond] of committed) {
    assert.ok(Number.isSafeInteger(chainId));
    assert.match(diamond, /^0x[0-9a-fA-F]{40}$/);
  }
  assert.deepEqual(
    [...bundleDiamonds({ 84532: { diamond: DIAMOND }, '0x1': { diamond: DIAMOND }, 97: { diamond: 'nope' }, 5: {} })],
    [[84532, DIAMOND]],
  );
});
