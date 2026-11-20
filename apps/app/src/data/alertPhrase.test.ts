// @vitest-environment jsdom
/**
 * #3346 — the alert phrase: the wallet signs its fingerprint, the phrase
 * rides the request only, and the copy this browser keeps while a
 * multi-signature wallet approves never holds it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertPhraseFingerprint } from '@vaipakam/lib/alertsMessage';
import { pendingPhraseMatches, setAlertPhrase } from './alerts';
import { loadPendingAlertRequest } from './alertRequest';

/** A wallet stand-in that records what it was asked to sign. */
function recordingSigner() {
  const signed: string[] = [];
  return {
    signed,
    signMessage: async (message: string) => {
      signed.push(message);
      return `0xsig${signed.length}`;
    },
  };
}

describe('setAlertPhrase (#3346)', () => {
  const WALLET = '0x1DAefA360ED370285f003Fa2d92DB75628088282' as const;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it('signs the fingerprint, sends the phrase, and keeps the request without it', async () => {
    vi.stubEnv('VITE_AGENT_ORIGIN', 'https://agent.test');
    const bodies: Record<string, unknown>[] = [];
    let kept: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        kept = loadPendingAlertRequest(84532, WALLET);
        return new Response(JSON.stringify({ ok: true, groupLinked: true, scope: 'network' }), { status: 200 });
      }),
    );
    const { signed, signMessage } = recordingSigner();
    expect(await setAlertPhrase(WALLET, 84532, 'blue heron', signMessage)).toEqual({ kind: 'set', groupLinked: true, scope: 'network' });
    expect(signed[0]).not.toContain('blue heron');
    const key = bodies[0]!.requestKey as `0x${string}`;
    expect(signed[0]).toContain(`Phrase fingerprint: ${alertPhraseFingerprint(key, 'blue heron')}`);
    expect(bodies[0]!.phrase).toBe('blue heron');
    // The copy kept while the wallet was asked never holds the phrase.
    expect(JSON.stringify(kept)).not.toContain('blue heron');
    expect(pendingPhraseMatches(kept as never, 'blue heron')).toBe(true);
    expect(pendingPhraseMatches(kept as never, 'red kite')).toBe(false);
  });

  it('says a private chat must be linked first, and refuses a phrase by its rule', async () => {
    vi.stubEnv('VITE_AGENT_ORIGIN', 'https://agent.test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no-private-chat' }), { status: 409 })));
    const { signMessage } = recordingSigner();
    expect(await setAlertPhrase(WALLET, 84532, 'blue heron', signMessage)).toEqual({ kind: 'no-private-chat' });
    await expect(setAlertPhrase(WALLET, 84532, ' blue heron', signMessage)).rejects.toThrow();
  });
});
