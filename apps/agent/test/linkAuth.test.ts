import { describe, it, expect } from 'vitest';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Env } from '../src/env';
import type { ChainSigChecker } from '../src/walletSigVerify';
import {
  buildAlertSettingsMessage,
  buildTelegramLinkMessage,
  buildTelegramTestMessage,
  buildTelegramUnlinkMessage,
  parseSignedLinkRequest,
  verifySignedLinkRequest,
  LINK_SIGNATURE_CHAIN_MAX_AGE_SECONDS,
  LINK_SIGNATURE_MAX_AGE_SECONDS,
} from '../src/linkAuth';
import { requestKeyHash } from '@vaipakam/lib/alertsMessage';

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
/** #3836 — the request key the "browser" drew, and the hash the signed
 *  text names. */
const KEY = `0x${'ab'.repeat(32)}` as const;
const KEY_HASH = requestKeyHash(KEY);

/** Fast-path cases need no chains; a checker that throws proves the
 *  chain is never consulted for a valid plain-ECDSA signature. */
const EMPTY_ENV = {} as Env;
const NEVER: ChainSigChecker = async () => {
  throw new Error('unexpected chain consult');
};
/** Negative cases must reach a DEFINITIVE no (#2009): a 65-byte
 *  signature by the wrong key is not a mismatch until a configured
 *  chain denies it — it could be a smart account's owner-key
 *  signature. Base Sepolia is in the consolidated deployments, so
 *  getChainConfigs keeps it. */
const CHAIN_ENV = { RPC_BASE_SEPOLIA: 'http://rpc.test' } as Env;
const DENY: ChainSigChecker = async () => false;
const CONFIRM: ChainSigChecker = async () => true;

const SETTINGS = { bands: { warnHf: 1.5, alertHf: 1.2, criticalHf: 1.05 }, dueDateReminders: false };
const SAVE_SETTINGS = { action: 'save-settings', settings: SETTINGS } as const;

async function signedBody(
  account: PrivateKeyAccount,
  wallet: string,
  issuedAt: number,
): Promise<Record<string, unknown>> {
  const signature = await account.signMessage({
    message: buildTelegramLinkMessage(wallet, CHAIN_ID, issuedAt, KEY_HASH),
  });
  return { wallet, chain_id: CHAIN_ID, issuedAt, signature, requestKey: KEY };
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
      const v = await verifySignedLinkRequest(parsed.req, NOW, EMPTY_ENV, 'link', NEVER);
      expect(v.ok).toBe(true);
    }
  });

  it("rejects another account signing for the victim's wallet", async () => {
    // The attack #1056 round 4 flagged: attacker B claims wallet A.
    const parsed = parseSignedLinkRequest(
      await signedBody(ACCOUNT_B, ACCOUNT_A.address, NOW),
    );
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW, CHAIN_ENV, 'link', DENY);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('does not match');
  });

  it('rejects a stale signature outside the replay window', async () => {
    const issuedAt = NOW - LINK_SIGNATURE_MAX_AGE_SECONDS - 1;
    const parsed = parseSignedLinkRequest(
      await signedBody(ACCOUNT_A, ACCOUNT_A.address, issuedAt),
    );
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW, EMPTY_ENV);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('stale');
  });

  it('accepts the owner signature for the unlink action', async () => {
    const signature = await ACCOUNT_A.signMessage({
      message: buildTelegramUnlinkMessage(ACCOUNT_A.address, CHAIN_ID, NOW, KEY_HASH),
    });
    const parsed = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
      issuedAt: NOW,
      signature,
      requestKey: KEY,
    });
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW, EMPTY_ENV, 'unlink', NEVER);
    expect(v.ok).toBe(true);
  });

  it('accepts the owner signature for a settings save it names', async () => {
    const signature = await ACCOUNT_A.signMessage({
      message: buildAlertSettingsMessage(ACCOUNT_A.address, CHAIN_ID, SETTINGS, NOW, KEY_HASH),
    });
    const parsed = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
      issuedAt: NOW,
      signature,
      requestKey: KEY,
    });
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW, EMPTY_ENV, SAVE_SETTINGS, NEVER);
    expect(v.ok).toBe(true);
  });

  it('refuses a settings signature presented for a different save (#2754)', async () => {
    // The signature covers what the save changes, so a captured one
    // cannot carry other bands, another due-date choice or a Push opt-in.
    const signature = await ACCOUNT_A.signMessage({
      message: buildAlertSettingsMessage(ACCOUNT_A.address, CHAIN_ID, SETTINGS, NOW, KEY_HASH),
    });
    const parsed = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
      issuedAt: NOW,
      signature,
      requestKey: KEY,
    });
    if (!parsed.ok) throw new Error('parse failed');
    for (const settings of [
      { ...SETTINGS, bands: { warnHf: 3, alertHf: 2, criticalHf: 1.5 } },
      { ...SETTINGS, dueDateReminders: true },
      { ...SETTINGS, pushAlerts: true as const },
      { bands: SETTINGS.bands },
    ]) {
      const v = await verifySignedLinkRequest(
        parsed.req,
        NOW,
        CHAIN_ENV,
        { action: 'save-settings', settings },
        DENY,
      );
      expect(v.ok).toBe(false);
    }
  });

  it('accepts the owner signature for the test-alert action', async () => {
    const signature = await ACCOUNT_A.signMessage({
      message: buildTelegramTestMessage(ACCOUNT_A.address, CHAIN_ID, NOW, KEY_HASH),
    });
    const parsed = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
      issuedAt: NOW,
      signature,
      requestKey: KEY,
    });
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW, EMPTY_ENV, 'test-alert', NEVER);
    expect(v.ok).toBe(true);
  });

  it('rejects cross-action replay (each action signature used for the others)', async () => {
    // The messages differ on purpose: a captured signature for one
    // action must never authorise another.
    const linkSig = await ACCOUNT_A.signMessage({
      message: buildTelegramLinkMessage(ACCOUNT_A.address, CHAIN_ID, NOW, KEY_HASH),
    });
    const unlinkSig = await ACCOUNT_A.signMessage({
      message: buildTelegramUnlinkMessage(ACCOUNT_A.address, CHAIN_ID, NOW, KEY_HASH),
    });
    const saveSig = await ACCOUNT_A.signMessage({
      message: buildAlertSettingsMessage(ACCOUNT_A.address, CHAIN_ID, SETTINGS, NOW, KEY_HASH),
    });
    const testSig = await ACCOUNT_A.signMessage({
      message: buildTelegramTestMessage(ACCOUNT_A.address, CHAIN_ID, NOW, KEY_HASH),
    });
    for (const [signature, action] of [
      [linkSig, 'unlink'],
      [unlinkSig, 'link'],
      [linkSig, SAVE_SETTINGS],
      [saveSig, 'unlink'],
      [testSig, 'link'],
      [linkSig, 'test-alert'],
      [testSig, 'unlink'],
    ] as const) {
      const parsed = parseSignedLinkRequest({
        wallet: ACCOUNT_A.address,
        chain_id: CHAIN_ID,
        issuedAt: NOW,
        signature,
        requestKey: KEY,
      });
      if (!parsed.ok) throw new Error('parse failed');
      const v = await verifySignedLinkRequest(parsed.req, NOW, CHAIN_ENV, action, DENY);
      expect(v.ok).toBe(false);
    }
  });

  it('rejects a signature over a different chain id', async () => {
    // Binding chain_id into the message means a signature captured
    // for one chain cannot be replayed to link another chain's row.
    const signature = await ACCOUNT_A.signMessage({
      message: buildTelegramLinkMessage(ACCOUNT_A.address, 1, NOW, KEY_HASH),
    });
    const parsed = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
      issuedAt: NOW,
      signature,
      requestKey: KEY,
    });
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW, CHAIN_ENV, 'link', DENY);
    expect(v.ok).toBe(false);
  });

  it('accepts a smart-account signature the signed chain confirms (#2009)', async () => {
    // The owner key differs from the wallet address (a Safe at A
    // owned by B) — recovery mismatches, ERC-1271 on the SIGNED
    // chain_id confirms.
    const signature = await ACCOUNT_B.signMessage({
      message: buildTelegramLinkMessage(ACCOUNT_A.address, CHAIN_ID, NOW, KEY_HASH),
    });
    const parsed = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
      issuedAt: NOW,
      signature,
      requestKey: KEY,
    });
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW, CHAIN_ENV, 'link', CONFIRM);
    expect(v.ok).toBe(true);
    // The verdict carries HOW it verified (#2013 r3): chain-scoped
    // contract approval, which the unlink handler must not spend on
    // wallet-wide effects.
    if (v.ok) expect(v.via).toBe('chain');
  });

  it("an ECDSA owner's verdict is via 'ecdsa' — universal authority (#2013 r3)", async () => {
    const parsed = parseSignedLinkRequest(
      await signedBody(ACCOUNT_A, ACCOUNT_A.address, NOW),
    );
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW, EMPTY_ENV, 'link', NEVER);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.via).toBe('ecdsa');
  });

  it('an unverifiable signature is 503 UNAVAILABLE, never a 401 mismatch (#2009)', async () => {
    // The signed chain has no configured RPC here — the Worker
    // cannot check, and must not call the signature invalid.
    const signature = await ACCOUNT_B.signMessage({
      message: buildTelegramLinkMessage(ACCOUNT_A.address, CHAIN_ID, NOW, KEY_HASH),
    });
    const parsed = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
      issuedAt: NOW,
      signature,
      requestKey: KEY,
    });
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW, EMPTY_ENV);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.status).toBe(503);
      expect(v.reason).toContain('unavailable');
    }
  });
});

describe('#3836 — a contract-approved request', () => {
  /** A stand-in Safe at ACCOUNT_A: it approves exactly the messages its
   *  owners approved, as ERC-1271 does, whatever the signature bytes. */
  function safeApproving(...approved: string[]): ChainSigChecker {
    return async (_rpc, _chain, _wallet, message) => approved.includes(message);
  }
  const OTHER_KEY = `0x${'cd'.repeat(32)}` as const;

  async function safeBody(issuedAt: number, requestKey: `0x${string}` = KEY) {
    // The bytes are an owner's signature, not the wallet's: recovery
    // mismatches and the chain decides.
    const signature = await ACCOUNT_B.signMessage({ message: 'owner approval' });
    const parsed = parseSignedLinkRequest({
      wallet: ACCOUNT_A.address,
      chain_id: CHAIN_ID,
      issuedAt,
      signature,
      requestKey,
    });
    if (!parsed.ok) throw new Error('parse failed');
    return parsed.req;
  }

  it('is accepted up to seven days after it was made', async () => {
    const issuedAt = NOW - LINK_SIGNATURE_CHAIN_MAX_AGE_SECONDS;
    const safe = safeApproving(buildTelegramLinkMessage(ACCOUNT_A.address, CHAIN_ID, issuedAt, KEY_HASH));
    const v = await verifySignedLinkRequest(await safeBody(issuedAt), NOW, CHAIN_ENV, 'link', safe);
    expect(v).toEqual({ ok: true, via: 'chain' });
  });

  it('is stale a second later, and never reaches the chain', async () => {
    const issuedAt = NOW - LINK_SIGNATURE_CHAIN_MAX_AGE_SECONDS - 1;
    const v = await verifySignedLinkRequest(await safeBody(issuedAt), NOW, CHAIN_ENV, 'link', NEVER);
    expect(v).toMatchObject({ ok: false, status: 400 });
  });

  it('may not be dated more than ten minutes ahead (the window is one-sided)', async () => {
    const issuedAt = NOW + LINK_SIGNATURE_MAX_AGE_SECONDS + 1;
    const v = await verifySignedLinkRequest(await safeBody(issuedAt), NOW, CHAIN_ENV, 'link', NEVER);
    expect(v).toMatchObject({ ok: false, status: 400 });
  });

  it("is refused without the requesting browser's key, though the approval is public", async () => {
    // Anyone can read a Safe's approval; only the browser that drew the
    // key can present it. A different key names a different message,
    // which the Safe never approved.
    const safe = safeApproving(buildTelegramLinkMessage(ACCOUNT_A.address, CHAIN_ID, NOW, KEY_HASH));
    expect((await verifySignedLinkRequest(await safeBody(NOW), NOW, CHAIN_ENV, 'link', safe)).ok).toBe(true);
    const v = await verifySignedLinkRequest(await safeBody(NOW, OTHER_KEY), NOW, CHAIN_ENV, 'link', safe);
    expect(v).toMatchObject({ ok: false, status: 401 });
  });

  it("keeps ten minutes for a signature that recovers to the wallet's own key", async () => {
    // Whatever code sits at the address: recovery to the wallet decides.
    const issuedAt = NOW - LINK_SIGNATURE_MAX_AGE_SECONDS - 1;
    const parsed = parseSignedLinkRequest(await signedBody(ACCOUNT_A, ACCOUNT_A.address, issuedAt));
    if (!parsed.ok) throw new Error('parse failed');
    const v = await verifySignedLinkRequest(parsed.req, NOW, CHAIN_ENV, 'link', CONFIRM);
    expect(v).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a body without a well-shaped request key', async () => {
    const body = await signedBody(ACCOUNT_A, ACCOUNT_A.address, NOW);
    for (const requestKey of [undefined, '0x1234', KEY.toUpperCase().replace('0X', '0x')]) {
      expect(parseSignedLinkRequest({ ...body, requestKey }).ok).toBe(false);
    }
  });
});
