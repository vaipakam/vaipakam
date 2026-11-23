// @vitest-environment jsdom
/**
 * #3836 — a signed alert request is kept in this browser from before the
 * wallet is asked until the alert service answers, so a wallet whose owners
 * take days to approve can finish it later, and only this browser can.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { DEFAULT_PREFS, saveAlertPrefs } from './alerts';

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

  it('keeps it only when the service refused it before recording it', async () => {
    const req = linkRequest();
    for (const [status, error] of [
      [503, 'verification-unavailable'],
      [429, 'rate-limited'],
      [503, 'rate-limit-unavailable'],
      [503, 'rate-limit-binding-missing'],
      [429, 'verification_failed'],
    ] as const) {
      await signAndSendAlertRequest(req, async () => '0xsig', async () => answer(status, error));
      expect(loadPendingAlertRequest(CHAIN, WALLET, NOW), `${status} ${error}`).not.toBeNull();
    }
    // Any other answer, refusals included, is final for this request.
    for (const [status, error] of [
      [409, 'request-superseded'],
      [409, 'request-already-used'],
      [503, 'link-unavailable'],
      [401, 'verification_failed'],
      [429, 'test-alert-cooldown'],
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

describe('a request that finishes drops only itself (#3836)', () => {
  beforeEach(() => localStorage.clear());

  it('keeps a newer request another tab started meanwhile', async () => {
    const older = linkRequest();
    const newer = linkRequest(NOW + 60);
    let release: (sig: string) => void = () => {};
    const signed = new Promise<string>((r) => (release = r));
    const run = signAndSendAlertRequest(older, () => signed, async () => answer(200));
    // Another tab starts a new request for the same wallet and chain.
    await signAndSendAlertRequest(newer, async () => Promise.reject(new Error('waiting')), async () => answer(200)).catch(
      () => {},
    );
    release('0xsig');
    await run;
    expect(loadPendingAlertRequest(CHAIN, WALLET, NOW + 60)?.requestKey).toBe(newer.requestKey);
  });

  it('a rejection does not drop a newer request either', async () => {
    const older = linkRequest();
    const newer = linkRequest(NOW + 60);
    let reject: (e: unknown) => void = () => {};
    const signed = new Promise<string>((_, r) => (reject = r));
    const run = signAndSendAlertRequest(older, () => signed, async () => answer(200)).catch(() => {});
    await signAndSendAlertRequest(newer, async () => Promise.reject(new Error('waiting')), async () => answer(200)).catch(
      () => {},
    );
    reject(new UserRejectedRequestError(new Error('no')));
    await run;
    expect(loadPendingAlertRequest(CHAIN, WALLET, NOW + 60)?.requestKey).toBe(newer.requestKey);
  });
});

describe('finishing an older request (#3836)', () => {
  beforeEach(() => localStorage.clear());

  it('does not overwrite a newer request another tab started', async () => {
    const older = linkRequest();
    const newer = linkRequest(NOW + 60);
    await signAndSendAlertRequest(older, async () => Promise.reject(new Error('waiting')), async () => answer(200)).catch(
      () => {},
    );
    // Another tab starts a newer request for the same wallet and network.
    await signAndSendAlertRequest(newer, async () => Promise.reject(new Error('waiting')), async () => answer(200)).catch(
      () => {},
    );
    // A stale card still showing the older one finishes it.
    let keptWhileAsked: string | undefined;
    await signAndSendAlertRequest(
      older,
      async () => {
        keptWhileAsked = loadPendingAlertRequest(CHAIN, WALLET, NOW + 60)?.requestKey;
        return '0xsig';
      },
      async () => answer(409, 'request-superseded'),
      'resume',
    );
    expect(keptWhileAsked).toBe(newer.requestKey);
    expect(loadPendingAlertRequest(CHAIN, WALLET, NOW + 60)?.requestKey).toBe(newer.requestKey);
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

describe('a kept save the agent refused Push for (#3836)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('still reports Push as not stored when it is finished later', async () => {
    vi.stubEnv('VITE_AGENT_ORIGIN', 'https://agent.test');
    const answers = [
      new Response(JSON.stringify({ error: 'push-unavailable' }), { status: 409 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => answers.shift()!));
    const prefs = { ...DEFAULT_PREFS, pushEnabled: true };
    let calls = 0;
    // The first save is answered "Push unavailable"; the wallet then stops
    // waiting on the save sent again without it, so that one is kept.
    await expect(
      saveAlertPrefs(WALLET as `0x${string}`, CHAIN, prefs, {
        signMessage: async () => {
          calls += 1;
          if (calls === 2) throw new Error('the wallet stopped waiting');
          return '0xsig';
        },
      }),
    ).rejects.toThrow(/stopped waiting/);
    const kept = loadPendingAlertRequest(CHAIN, WALLET);
    expect(kept?.kind).toBe('save-settings');
    expect(kept?.body.push_channel).toBeUndefined();

    // Finished later, in a fresh call: the agent stores the rest, and Push
    // is still reported as refused.
    const outcome = await saveAlertPrefs(WALLET as `0x${string}`, CHAIN, prefs, {
      signMessage: async () => '0xsig',
      resume: kept!,
    });
    // The refused request's reference is not kept, so a finish reports none.
    expect(outcome).toEqual({ push: 'unavailable', pushRefusalReference: null });
  });
});
