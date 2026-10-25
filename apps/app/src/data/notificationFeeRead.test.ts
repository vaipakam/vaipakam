/**
 * #2723 follow-up — what the paid-Push read reports on each kind of Diamond,
 * driven through a REAL viem client against a transport that answers per
 * selector, so the "older deployment" branch is recognised from the decoded
 * revert exactly as it is live.
 */
import { describe, expect, it } from 'vitest';
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { readNotificationFee } from './notificationFee';

const DIAMOND = '0x0000000000000000000000000000000000000001';
const WALLET = '0x0000000000000000000000000000000000000002';
const HOST = '0x0000000000000000000000000000000000000003';
const ZERO = '0x0000000000000000000000000000000000000000';
const FEE = 5n * 10n ** 17n;
const FN_MISSING = '0xa9ad62f8';

const SEL = {
  config: toFunctionSelector('getNotificationFeeConfig()'),
  consent: toFunctionSelector('getNotificationFeeConsent(address)'),
  facetAddress: toFunctionSelector('facetAddress(bytes4)'),
};

type Answer = Hex | { revert: Hex } | { fail: true };

function clientWith(answers: Partial<Record<keyof typeof SEL, Answer>>) {
  return createPublicClient({
    transport: custom(
      {
        async request({ method, params }) {
          if (method === 'eth_blockNumber') return '0x64';
          if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
          const data = (params as [{ data: Hex }])[0].data;
          const key = (Object.keys(SEL) as (keyof typeof SEL)[]).find((k) =>
            data.startsWith(SEL[k]),
          );
          const answer = key ? answers[key] : undefined;
          if (answer === undefined) throw new Error(`no answer for ${data.slice(0, 10)}`);
          if (typeof answer === 'string') return answer;
          if ('revert' in answer) {
            throw Object.assign(new Error('execution reverted'), {
              code: 3,
              data: answer.revert,
            });
          }
          throw new Error('network down');
        },
      },
      { retryCount: 0 },
    ),
  });
}

const config = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [FEE, 0n]);
const consentOf = (cap: bigint, covers: boolean) =>
  encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [cap, covers]);
const hostIs = (a: string) => encodeAbiParameters([{ type: 'address' }], [a as Hex]);

describe('readNotificationFee', () => {
  it('reads the consent record where the Diamond keeps one', async () => {
    const r = await readNotificationFee(
      clientWith({ config, consent: consentOf(FEE, true) }),
      DIAMOND,
      WALLET,
    );
    expect(r).toEqual({
      kind: 'consent-record',
      consent: {
        feeVpfi: FEE,
        capVpfi: FEE,
        coversCurrentFee: true,
        atBlock: 100n,
      },
    });
  });

  it('names an older Diamond whose billing call is still routed', async () => {
    const r = await readNotificationFee(
      clientWith({
        config,
        consent: { revert: FN_MISSING },
        facetAddress: hostIs(HOST),
      }),
      DIAMOND,
      WALLET,
    );
    expect(r).toEqual({
      kind: 'predates-consent',
      feeVpfi: FEE,
      atBlock: 100n,
      billingRouted: true,
    });
  });

  it('names an older Diamond with no billing call', async () => {
    const r = await readNotificationFee(
      clientWith({
        config,
        consent: { revert: FN_MISSING },
        facetAddress: hostIs(ZERO),
      }),
      DIAMOND,
      WALLET,
    );
    expect(r).toMatchObject({ kind: 'predates-consent', billingRouted: false });
  });

  it('says the billing route is unknown when the loupe cannot be read', async () => {
    const r = await readNotificationFee(
      clientWith({
        config,
        consent: { revert: FN_MISSING },
        facetAddress: { fail: true },
      }),
      DIAMOND,
      WALLET,
    );
    expect(r).toMatchObject({ kind: 'predates-consent', billingRouted: null });
  });

  it('treats any other consent failure as a failed read, never an older Diamond', async () => {
    await expect(
      readNotificationFee(clientWith({ config, consent: { fail: true } }), DIAMOND, WALLET),
    ).rejects.toBeTruthy();
    await expect(
      readNotificationFee(
        clientWith({ config, consent: { revert: '0xdeadbeef' } }),
        DIAMOND,
        WALLET,
      ),
    ).rejects.toBeTruthy();
  });

  it('fails when the fee itself cannot be read', async () => {
    await expect(
      readNotificationFee(
        clientWith({ config: { fail: true }, consent: consentOf(0n, false) }),
        DIAMOND,
        WALLET,
      ),
    ).rejects.toBeTruthy();
  });
});
