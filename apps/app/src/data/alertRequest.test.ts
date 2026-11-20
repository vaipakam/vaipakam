// @vitest-environment jsdom
/**
 * #3836 — a signed alert request is kept in this browser from before the
 * wallet is asked until the alert service answers, so a wallet whose owners
 * take days to approve can finish it later, and only this browser can.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { UserRejectedRequestError } from 'viem';
import { buildTelegramLinkMessage, isRequestKey, requestKeyHash } from '@vaipakam/lib/alertsMessage';
import {
  ALERT_REQUEST_MAX_AGE_SECONDS,
  clearPendingAlertRequest,
  loadPendingAlertRequest,
  newAlertRequest,
  pendingExpiresAt,
  signAndSendAlertRequest,
  type AlertServiceAnswer,
} from './alertRequest';

const WALLET = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
const CHAIN = 84532;
const NOW = 1_800_000_000;

function linkRequest(now = NOW) {
  return newAlertRequest(
    'link',
    WALLET,
    CHAIN,
    '/link/telegram',
    { wallet: WALLET, chain_id: CHAIN },
    (issuedAt, keyHash) => buildTelegramLinkMessage(WALLET, CHAIN, issuedAt, keyHash),
    undefined,
    now,
  );
}

const answer = (status: number, error?: string): AlertServiceAnswer => ({
  ok: status < 300,
  status,
  data: error ? { error } : {},
});

beforeEach(() => localStorage.clear());

describe('newAlertRequest', () => {
  it('draws a fresh key and signs over its hash, never the key itself', () => {
    const a = linkRequest();
    const b = linkRequest();
    expect(isRequestKey(a.requestKey)).toBe(true);
    expect(a.requestKey).not.toBe(b.requestKey);
    expect(a.message).toContain(requestKeyHash(a.requestKey));
    expect(a.message).not.toContain(a.requestKey.slice(2));
    expect(a.issuedAt).toBe(NOW);
  });
});

describe('signAndSendAlertRequest', () => {
  it('keeps the request while the wallet is asked, and sends the key with it', async () => {
    const req = linkRequest();
    let keptWhileAsked = false;
    let sent: Record<string, unknown> | null = null;
    await signAndSendAlertRequest(
      req,
      async (message) => {
        keptWhileAsked = loadPendingAlertRequest(CHAIN, WALLET, NOW)?.message === message;
        return '0xsig';
      },
      async (_path, body) => {
        sent = body;
        return answer(200);
      },
    );
    expect(keptWhileAsked).toBe(true);
    expect(sent).toEqual({ wallet: WALLET, chain_id: CHAIN, issuedAt: NOW, signature: '0xsig', requestKey: req.requestKey });
    // Answered: dropped.
    expect(loadPendingAlertRequest(CHAIN, WALLET, NOW)).toBeNull();
  });

  it('keeps it when the wallet gave up waiting, and drops it when the owner rejected it', async () => {
    const req = linkRequest();
    await expect(
      signAndSendAlertRequest(req, async () => Promise.reject(new Error('timed out')), async () => answer(200)),
    ).rejects.toThrow('timed out');
    expect(loadPendingAlertRequest(CHAIN, WALLET, NOW)?.requestKey).toBe(req.requestKey);
    await expect(
      signAndSendAlertRequest(
        req,
        async () => Promise.reject(new UserRejectedRequestError(new Error('no'))),
        async () => answer(200),
      ),
    ).rejects.toBeInstanceOf(UserRejectedRequestError);
    expect(loadPendingAlertRequest(CHAIN, WALLET, NOW)).toBeNull();
  });

  it('keeps it only when the service could not check it yet, which records nothing', async () => {
    const req = linkRequest();
    await signAndSendAlertRequest(req, async () => '0xsig', async () => answer(503, 'verification-unavailable'));
    expect(loadPendingAlertRequest(CHAIN, WALLET, NOW)).not.toBeNull();
    // Any other answer, refusals included, is final for this request.
    for (const [status, error] of [
      [409, 'request-superseded'],
      [409, 'request-already-used'],
      [503, 'link-unavailable'],
      [401, 'verification_failed'],
    ] as const) {
      await signAndSendAlertRequest(req, async () => '0xsig', async () => answer(status, error));
      expect(loadPendingAlertRequest(CHAIN, WALLET, NOW)).toBeNull();
    }
  });
});

describe('loadPendingAlertRequest', () => {
  it('drops a request once it is older than the service accepts', async () => {
    const req = linkRequest();
    await signAndSendAlertRequest(req, async () => Promise.reject(new Error('waiting')), async () => answer(200)).catch(
      () => {},
    );
    expect(pendingExpiresAt(req)).toBe(NOW + ALERT_REQUEST_MAX_AGE_SECONDS);
    expect(loadPendingAlertRequest(CHAIN, WALLET, pendingExpiresAt(req))).not.toBeNull();
    expect(loadPendingAlertRequest(CHAIN, WALLET, pendingExpiresAt(req) + 1)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('is kept per wallet and chain, and refuses anything malformed', () => {
    localStorage.setItem(`vaipakam.alerts.pendingRequest.v1.${CHAIN}.${WALLET.toLowerCase()}`, '{"kind":"link"}');
    expect(loadPendingAlertRequest(CHAIN, WALLET, NOW)).toBeNull();
    expect(loadPendingAlertRequest(97, WALLET, NOW)).toBeNull();
    clearPendingAlertRequest(CHAIN, WALLET);
    expect(localStorage.length).toBe(0);
  });
});

describe('the data-rights export (#3836)', () => {
  it('shows a pending request but withholds its key, saying so', async () => {
    const { inspectMyData, WITHHELD_REQUEST_KEY } = await import('../lib/dataRights');
    const req = linkRequest();
    await signAndSendAlertRequest(req, async () => Promise.reject(new Error('waiting')), async () => answer(200)).catch(
      () => {},
    );
    const exported = JSON.stringify(inspectMyData().payload);
    expect(exported).not.toContain(req.requestKey.slice(2));
    expect(exported).toContain(JSON.stringify(WITHHELD_REQUEST_KEY).slice(1, -1));
    // The browser's own copy is untouched: it can still finish the request.
    expect(loadPendingAlertRequest(CHAIN, WALLET, NOW)?.requestKey).toBe(req.requestKey);
  });
});
