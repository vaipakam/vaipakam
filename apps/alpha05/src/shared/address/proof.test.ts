import { describe, expect, it } from 'vitest';
import { createPublicClient, custom } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHALLENGE_LIFETIME_S, controlTypedData, decodeChallenge, decodeProof, encodeChallenge, encodeProof, newChallenge, verifyProof } from './proof';

type Hex = `0x${string}`;
const signer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const other = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ACCOUNT = '0x00000000000000000000000000000000000000e1' as Hex;
const NOW = 1_800_000_000;
const fixed = (n: number) => new Uint8Array(n).fill(7);

// An EOA's signature is checked locally; the client is never asked.
const client = createPublicClient({ transport: custom({ request: async () => { throw new Error('no network'); } }) });

const challenge = newChallenge({ chainId: 84532, diamond: DIAMOND, account: ACCOUNT, destination: signer.address, purpose: 'destination' }, NOW, fixed);

describe('proof of control', () => {
  it('round-trips the request and the answer through their codes', () => {
    expect(decodeChallenge(encodeChallenge(challenge))).toEqual(challenge);
    const proof = { challenge, signature: '0x1234' as Hex };
    expect(decodeProof(encodeProof(proof))).toEqual(proof);
    expect(decodeChallenge('not a code')).toBeNull();
    expect(decodeProof(encodeChallenge(challenge))).toBeNull();
  });

  it('accepts the address’s own signature, and only that', async () => {
    const good = await signer.signTypedData(controlTypedData(challenge));
    expect(await verifyProof(client, { challenge, signature: good }, challenge, NOW + 60)).toEqual({ ok: true });
    const forged = await other.signTypedData(controlTypedData(challenge));
    expect(await verifyProof(client, { challenge, signature: forged }, challenge, NOW + 60)).toMatchObject({ ok: false });
  });

  it('refuses an answer to another request, or one too late', async () => {
    const good = await signer.signTypedData(controlTypedData(challenge));
    const later = newChallenge({ ...challenge }, NOW + 5, () => new Uint8Array(32).fill(9));
    expect(await verifyProof(client, { challenge, signature: good }, later, NOW + 60)).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyProof(client, { challenge, signature: good }, challenge, NOW + CHALLENGE_LIFETIME_S + 1)).toEqual({ ok: false, reason: 'expired' });
  });
});
