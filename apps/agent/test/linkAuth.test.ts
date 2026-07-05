import { describe, it, expect } from 'vitest';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  buildTelegramLinkMessage,
  parseSignedLinkRequest,
  verifySignedLinkRequest,
  LINK_SIGNATURE_MAX_AGE_SECONDS,
} from '../src/linkAuth';

// Anvil's first two well-known dev keys — fine in a test, never a
// real key.
const ACCOUNT_A: PrivateKeyAccount = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const ACCOUNT_B: PrivateKeyAccount = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const CHAIN_ID = 84532;
const NOW = 1_750_000_000;

async function signedBody(
  account: PrivateKeyAccount,
  wallet: string,
  issuedAt: number,
): Promise<Record<string, unknown>> {
  const signature = await account.signMessage({
    message: buildTelegramLinkMessage(wallet, CHAIN_ID, issuedAt),
  });
  return { wallet, chain_id: CHAIN_ID, issuedAt, signature };
}

describe('parseSignedLinkRequest', () => {
  it('rejects a body without a signature (the pre-#1056 shape)', () => {
    const r = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed signature string', () => {
    const r = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
      issuedAt: NOW,
      signature: '0xnot-a-signature',
    });
    expect(r.ok).toBe(false);
  });

  it('accepts a well-shaped signed body', async () => {
    const r = parseSignedLinkRequest(
      await signedBody(ACCOUNT_A, ACCOUNT_A.address, NOW),
    );
    expect(r.ok).toBe(true);
  });
});

describe('verifySignedLinkRequest', () => {
  it('accepts the wallet owner signature (checksummed and lowercase)', async () => {
    for (const spelling of [
      ACCOUNT_A.address,
      ACCOUNT_A.address.toLowerCase(),
    ]) {
      const parsed = parseSignedLinkRequest(
        await signedBody(ACCOUNT_A, spelling, NOW),
      );
      if (!parsed.ok) throw new Error('parse failed');
      const v = await verifySignedLinkRequest(parsed.req, NOW);
      expect(v.ok).toBe(true);
    }
  });

  it("rejects another account signing for the victim's wallet", async () => {
    // The attack #1056 round 4 flagged: attacker B claims wallet A.
    const parsed = parseSignedLinkRequest(
      await signedBody(ACCOUNT_B, ACCOUNT_A.address, NOW),
    );
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('does not match');
  });

  it('rejects a stale signature outside the replay window', async () => {
    const issuedAt = NOW - LINK_SIGNATURE_MAX_AGE_SECONDS - 1;
    const parsed = parseSignedLinkRequest(
      await signedBody(ACCOUNT_A, ACCOUNT_A.address, issuedAt),
    );
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('stale');
  });

  it('rejects a signature over a different chain id', async () => {
    // Binding chain_id into the message means a signature captured
    // for one chain cannot be replayed to link another chain's row.
    const signature = await ACCOUNT_A.signMessage({
      message: buildTelegramLinkMessage(ACCOUNT_A.address, 1, NOW),
    });
    const parsed = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
      issuedAt: NOW,
      signature,
    });
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW);
    expect(v.ok).toBe(false);
  });
});
