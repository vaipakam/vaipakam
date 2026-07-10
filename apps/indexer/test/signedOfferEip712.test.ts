/**
 * Rate Desk phase 3 (#1131) — the signed-offer book's EIP-712 ingest gate.
 *
 * Two layers under test:
 *
 *   1. `signedOfferEip712.ts` — the hash/verify helpers MUST agree with
 *      `contracts/src/libraries/LibSignedOffer.sol` byte-for-byte. The
 *      known-good vector here is constructed INDEPENDENTLY of the helper:
 *      the typehash is keccak256 of a byte-for-byte copy of the contract's
 *      canonical type string (LibSignedOffer.sol:74-105), the struct hash is
 *      a manual `keccak256(abi.encode(typehash, ...29 static words))`, and
 *      the digest is a manual `keccak256(0x1901 ‖ domainSeparator ‖
 *      structHash)` with the domain separator assembled from the contract's
 *      domain constants (LibSignedOffer.sol:132-154). If the helper's
 *      viem-typed description ever drifts from the Solidity struct (field
 *      order, a type, the domain name), these assertions break.
 *
 *   2. `validateOrder` (signedOfferRoutes.ts) — the strict shape gate for
 *      the public POST surface.
 */
import { describe, expect, it } from 'vitest';
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  SIGNED_OFFER_TYPES,
  SIGNED_OFFER_FIELD_NAMES,
  ceilingOf,
  orderHashOf,
  signedOfferDigest,
  signedOfferDomain,
  toTypedMessage,
  verifySignedOfferSignature,
  type SignedOrderWire,
} from '../src/signedOfferEip712';
import { validateOrder } from '../src/signedOfferRoutes';

// Byte-for-byte copy of the contract's canonical type string —
// LibSignedOffer.sol SIGNED_OFFER_TYPEHASH (lines 74-105).
const CONTRACT_TYPE_STRING =
  'SignedOffer(' +
  'uint8 offerType,' +
  'address lendingAsset,' +
  'uint256 amount,' +
  'uint256 amountMax,' +
  'uint256 interestRateBps,' +
  'uint256 interestRateBpsMax,' +
  'address collateralAsset,' +
  'uint256 collateralAmount,' +
  'uint256 collateralAmountMax,' +
  'uint256 durationDays,' +
  'uint8 assetType,' +
  'uint8 collateralAssetType,' +
  'uint256 tokenId,' +
  'uint256 quantity,' +
  'uint256 collateralTokenId,' +
  'uint256 collateralQuantity,' +
  'address prepayAsset,' +
  'bool allowsPartialRepay,' +
  'bool allowsPrepayListing,' +
  'bool allowsParallelSale,' +
  'uint64 expiresAt,' +
  'uint8 fillMode,' +
  'uint8 periodicInterestCadence,' +
  'uint256 refinanceTargetLoanId,' +
  'bool useFullTermInterest,' +
  'address signer,' +
  'uint256 nonce,' +
  'uint256 deadline' +
  ')';

const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex; // anvil key 0
const SIGNER = privateKeyToAccount(TEST_PK);
const DIAMOND = '0x00000000000000000000000000000000000d1a0d' as Hex;
const CHAIN_ID = 84532;

const FUTURE = 4102444800; // 2100-01-01 — safely past any test clock

function makeOrder(overrides: Partial<SignedOrderWire> = {}): SignedOrderWire {
  return {
    offerType: '0',
    lendingAsset: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    amount: '1000000000000000000',
    amountMax: '5000000000000000000',
    interestRateBps: '500',
    interestRateBpsMax: '800',
    collateralAsset: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    collateralAmount: '2000000000000000000',
    // Single-value: the default fixture is a LENDER order (offerType 0)
    // and `validateOrder` mirrors `LenderCollateralRangeNotAllowed`.
    collateralAmountMax: '2000000000000000000',
    durationDays: '30',
    assetType: '0',
    collateralAssetType: '0',
    tokenId: '0',
    quantity: '0',
    collateralTokenId: '0',
    collateralQuantity: '0',
    prepayAsset: '0x0000000000000000000000000000000000000000',
    allowsPartialRepay: true,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    expiresAt: '0',
    fillMode: '0',
    periodicInterestCadence: '0',
    refinanceTargetLoanId: '0',
    useFullTermInterest: false,
    signer: SIGNER.address.toLowerCase(),
    nonce: '7',
    deadline: String(FUTURE),
    ...overrides,
  };
}

describe('signedOfferEip712 — hash agreement with LibSignedOffer.sol', () => {
  it('the typed-data description derives EXACTLY the contract typehash string', () => {
    // Rebuild the canonical encodeType from SIGNED_OFFER_TYPES the way
    // EIP-712 does and pin it against the contract's string. This is the
    // load-bearing drift guard: field ORDER and TYPES both feed it.
    const derived =
      'SignedOffer(' +
      SIGNED_OFFER_TYPES.SignedOffer.map((f) => `${f.type} ${f.name}`).join(',') +
      ')';
    expect(derived).toBe(CONTRACT_TYPE_STRING);
    expect(SIGNED_OFFER_FIELD_NAMES.length).toBe(28);
  });

  it('orderHashOf equals a manually-assembled keccak256(abi.encode(typehash, ...fields))', () => {
    const order = makeOrder();
    const typehash = keccak256(stringToHex(CONTRACT_TYPE_STRING));
    // EIP-712 hashStruct for an all-static struct is the plain 32-byte-word
    // abi.encode of (typehash, field...) — exactly what LibSignedOffer's
    // three-chunk `bytes.concat(abi.encode(...))` produces.
    const msg = toTypedMessage(order);
    const manual = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          ...SIGNED_OFFER_TYPES.SignedOffer.map((f) => ({ type: f.type })),
        ],
        [
          typehash,
          ...SIGNED_OFFER_TYPES.SignedOffer.map(
            (f) => (msg as Record<string, unknown>)[f.name],
          ),
        ] as never,
      ),
    );
    expect(orderHashOf(order)).toBe(manual);
  });

  it('signedOfferDigest equals keccak256(0x1901 ‖ domainSeparator ‖ structHash)', () => {
    const order = makeOrder();
    // Domain separator assembled from the contract's constants
    // (LibSignedOffer.sol:132-154).
    const domainTypehash = keccak256(
      stringToHex(
        'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
      ),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'address' },
        ],
        [
          domainTypehash,
          keccak256(stringToHex('Vaipakam SignedOffer')),
          keccak256(stringToHex('1')),
          BigInt(CHAIN_ID),
          DIAMOND,
        ],
      ),
    );
    const manual = keccak256(
      concatHex(['0x1901', domainSeparator, orderHashOf(order)]),
    );
    expect(signedOfferDigest(order, CHAIN_ID, DIAMOND)).toBe(manual);
  });

  it('changing any field changes the order hash (digest binds every term)', () => {
    const base = orderHashOf(makeOrder());
    expect(orderHashOf(makeOrder({ interestRateBps: '501' }))).not.toBe(base);
    expect(orderHashOf(makeOrder({ allowsPartialRepay: false }))).not.toBe(base);
    expect(orderHashOf(makeOrder({ nonce: '8' }))).not.toBe(base);
  });
});

describe('signedOfferEip712 — signature verification', () => {
  async function sign(order: SignedOrderWire, chainId = CHAIN_ID, diamond = DIAMOND) {
    return SIGNER.signTypedData({
      domain: signedOfferDomain(chainId, diamond as Hex),
      types: SIGNED_OFFER_TYPES,
      primaryType: 'SignedOffer',
      message: toTypedMessage(order),
    });
  }

  it('accepts the signer’s own signature', async () => {
    const order = makeOrder();
    const sig = await sign(order);
    expect(
      await verifySignedOfferSignature(order, sig, CHAIN_ID, DIAMOND),
    ).toBe(true);
  });

  it('rejects a signature over TAMPERED terms', async () => {
    const order = makeOrder();
    const sig = await sign(order);
    const tampered = makeOrder({ amount: '999' });
    expect(
      await verifySignedOfferSignature(tampered, sig, CHAIN_ID, DIAMOND),
    ).toBe(false);
  });

  it('rejects a cross-chain / cross-diamond replay (domain binding)', async () => {
    const order = makeOrder();
    const sig = await sign(order);
    expect(await verifySignedOfferSignature(order, sig, 1, DIAMOND)).toBe(false);
    expect(
      await verifySignedOfferSignature(
        order,
        sig,
        CHAIN_ID,
        '0xcccccccccccccccccccccccccccccccccccccccc' as Hex,
      ),
    ).toBe(false);
  });

  it('rejects a signature from a DIFFERENT key than order.signer', async () => {
    const order = makeOrder({
      signer: '0xdddddddddddddddddddddddddddddddddddddddd',
    });
    const sig = await sign(order); // signed by SIGNER, claims to be 0xdd…
    expect(
      await verifySignedOfferSignature(order, sig, CHAIN_ID, DIAMOND),
    ).toBe(false);
  });

  it('treats malformed signature bytes as a clean failure, not a throw', async () => {
    const order = makeOrder();
    expect(
      await verifySignedOfferSignature(order, '0x1234' as Hex, CHAIN_ID, DIAMOND),
    ).toBe(false);
  });
});

describe('ceilingOf — mirrors SignedOfferFacet._ceiling', () => {
  it('amountMax 0 collapses to amount; otherwise amountMax', () => {
    expect(ceilingOf('100', '0')).toBe(100n);
    expect(ceilingOf('100', '500')).toBe(500n);
  });
});

describe('validateOrder — the POST shape gate', () => {
  const NOW = 1783000000; // fixed clock well before FUTURE

  it('accepts a canonical order and lowercases addresses', () => {
    const raw = makeOrder({
      lendingAsset: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }) as unknown as Record<string, unknown>;
    const out = validateOrder(raw, NOW);
    expect('order' in out).toBe(true);
    if ('order' in out) {
      expect(out.order.lendingAsset).toBe(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
    }
  });

  function expectError(raw: Record<string, unknown>, error: string) {
    const out = validateOrder(raw, NOW);
    expect(out).toEqual({ error });
  }

  it('rejects a missing / extra field (exact 28-key contract)', () => {
    const missing = makeOrder() as unknown as Record<string, unknown>;
    delete missing.nonce;
    expectError(missing, 'order-field-count');

    const extra = {
      ...(makeOrder() as unknown as Record<string, unknown>),
    };
    delete extra.nonce;
    extra.bogus = '1';
    expectError(extra, 'order-unknown-field-bogus');
  });

  it('rejects out-of-range enums', () => {
    expectError(
      makeOrder({ offerType: '2' }) as unknown as Record<string, unknown>,
      'invalid-offerType',
    );
    expectError(
      makeOrder({ fillMode: '3' }) as unknown as Record<string, unknown>,
      'invalid-fillMode',
    );
    expectError(
      makeOrder({ periodicInterestCadence: '5' }) as unknown as Record<
        string,
        unknown
      >,
      'invalid-periodicInterestCadence',
    );
  });

  it('rejects non-canonical decimals and oversized uints', () => {
    expectError(
      makeOrder({ amount: '01' }) as unknown as Record<string, unknown>,
      'invalid-amount',
    );
    expectError(
      makeOrder({ nonce: String(2n ** 256n) }) as unknown as Record<
        string,
        unknown
      >,
      'invalid-nonce',
    );
  });

  it('rejects a zero principal (unfillable by contract construction)', () => {
    expectError(
      makeOrder({ amount: '0' }) as unknown as Record<string, unknown>,
      'invalid-amount',
    );
  });

  it('bounds durationDays to the 1..4385 governance ceiling', () => {
    expectError(
      makeOrder({ durationDays: '0' }) as unknown as Record<string, unknown>,
      'invalid-durationDays',
    );
    expectError(
      makeOrder({ durationDays: '4386' }) as unknown as Record<string, unknown>,
      'invalid-durationDays',
    );
  });

  it('rejects lapsed deadline / expiresAt; 0 stays GTC-valid', () => {
    expectError(
      makeOrder({ deadline: String(NOW - 1) }) as unknown as Record<
        string,
        unknown
      >,
      'invalid-deadline',
    );
    expectError(
      makeOrder({ expiresAt: String(NOW) }) as unknown as Record<string, unknown>,
      'invalid-expiresAt',
    );
    const gtc = validateOrder(
      makeOrder({ deadline: '0', expiresAt: '0' }) as unknown as Record<
        string,
        unknown
      >,
      NOW,
    );
    expect('order' in gtc).toBe(true);
  });

  it('rejects a wrongly-typed bool', () => {
    expectError(
      makeOrder({
        allowsPartialRepay: 'true' as unknown as boolean,
      }) as unknown as Record<string, unknown>,
      'invalid-allowsPartialRepay',
    );
  });

  // ── Static fill-path materialization invariants (Codex #1145 r1) ──
  // Each mirrors the contract error `createSignedOfferVault`'s path
  // would revert with — a stored violation would advertise an order a
  // taker signs + approves for that can NEVER fill.
  describe('materialization invariants', () => {
    const raw = (o: Partial<SignedOrderWire>) =>
      makeOrder(o) as unknown as Record<string, unknown>;

    it('rejects zero amountMax (AmountMaxMustBePositive)', () => {
      expectError(raw({ amountMax: '0' }), 'invalid-amountMax');
    });

    it('rejects amountMax below amount (InvalidAmountRange)', () => {
      expectError(
        raw({ amount: '100', amountMax: '99' }),
        'amount-range',
      );
    });

    it('rejects an inverted rate range (InvalidRateRange); a zero-zero rate stays valid', () => {
      expectError(
        raw({ interestRateBps: '800', interestRateBpsMax: '500' }),
        'rate-range',
      );
      // No-interest shape: zero on both ends is structurally meaningful.
      const zeroRate = validateOrder(
        raw({ interestRateBps: '0', interestRateBpsMax: '0' }),
        NOW,
      );
      expect('order' in zeroRate).toBe(true);
    });

    it('rejects a rate ceiling above 10000 bps (InterestRateAboveCeiling)', () => {
      expectError(
        raw({ interestRateBps: '500', interestRateBpsMax: '10001' }),
        'rate-above-ceiling',
      );
    });

    it('rejects AON with a non-trivial amount range (AonRequiresSingleValueAmount)', () => {
      expectError(raw({ fillMode: '1' }), 'aon-single-value'); // fixture: 1e18..5e18
      const single = validateOrder(
        raw({ fillMode: '1', amount: '5', amountMax: '5' }),
        NOW,
      );
      expect('order' in single).toBe(true);
    });

    it('rejects IOC without an expiry (IocRequiresExpiry)', () => {
      expectError(
        raw({ fillMode: '2', amount: '5', amountMax: '5', expiresAt: '0' }),
        'ioc-requires-expiry',
      );
      const withExpiry = validateOrder(
        raw({ fillMode: '2', expiresAt: String(NOW + 86_400) }),
        NOW,
      );
      expect('order' in withExpiry).toBe(true);
    });

    it('rejects a mixed-zero collateral pair; both-zero (explicit no-collateral) passes', () => {
      expectError(
        raw({ collateralAmount: '0', collateralAmountMax: '5' }),
        'invalid-collateralAmount', // CollateralMustBePositive
      );
      expectError(
        raw({ collateralAmount: '5', collateralAmountMax: '0' }),
        'invalid-collateralAmountMax', // CollateralAmountMaxMustBePositive
      );
      const noCollateral = validateOrder(
        raw({ collateralAmount: '0', collateralAmountMax: '0' }),
        NOW,
      );
      expect('order' in noCollateral).toBe(true);
    });

    it('rejects collateralAmountMax below collateralAmount (InvalidCollateralAmountRange)', () => {
      expectError(
        raw({
          offerType: '1',
          collateralAmount: '10',
          collateralAmountMax: '9',
        }),
        'collateral-range',
      );
    });

    it('rejects a RANGED lender collateral (LenderCollateralRangeNotAllowed); borrower ranges pass', () => {
      expectError(
        raw({
          offerType: '0',
          collateralAmount: '10',
          collateralAmountMax: '20',
        }),
        'lender-collateral-range',
      );
      const borrowerRange = validateOrder(
        raw({
          offerType: '1',
          collateralAmount: '10',
          collateralAmountMax: '20',
        }),
        NOW,
      );
      expect('order' in borrowerRange).toBe(true);
    });

    it('rejects non-ERC-20 legs and refinance tags (SignedOfferUnsupportedShape, v0.5 scope)', () => {
      expectError(raw({ assetType: '1' }), 'unsupported-asset-type');
      expectError(raw({ collateralAssetType: '2' }), 'unsupported-asset-type');
      expectError(
        raw({ refinanceTargetLoanId: '7' }),
        'unsupported-refinance',
      );
    });

    it('rejects allowsParallelSale (needs NFT collateral — impossible under the v0.5 ERC-20 shape)', () => {
      expectError(raw({ allowsParallelSale: true }), 'unsupported-parallel-sale');
    });

    it('rejects a self-collateralized pair (SelfCollateralizedOffer)', () => {
      expectError(
        raw({
          collateralAsset: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        }),
        'self-collateralized', // lendingAsset is the same 0xaa… address
      );
    });
  });
});
