/**
 * What `sendMessage` says happened (#2213 r24 `4015538638`).
 *
 * It used to return a boolean, which flattened two failures that need
 * opposite operator responses: a service that ANSWERED and refused — a
 * rotated token, a chat the bot was removed from, which keeps failing until
 * someone fixes a credential — and a transport failure that never got an
 * answer at all, which may be a passing incident and may have delivered.
 *
 * The function always knew the difference structurally: a throw before any
 * response versus a response that said no. Only the return type threw it
 * away, so the lane above could not count them apart however carefully it
 * tried — and the release note promised it did.
 *
 * THIS SUITE EXERCISES THE REAL MODULE. The lane's own suite mocks
 * `../src/telegram` wholesale, so nothing there can pin what the real
 * function returns — a mutation flipping `refused` to `unknown` inside it
 * passed every lane test. That is the fourth "test passed for the wrong
 * reason" in this PR, and the shape is always the same: the assertion sat on
 * a layer that could not observe the change.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendMessage } from '../src/telegram';

const TOKEN = 'test-token';
const CHAT = '12345';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('what sendMessage reports', () => {
  it('reports a message the service accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
    );
    expect(await sendMessage(TOKEN, CHAT, 'hello')).toBe('accepted');
  });

  it('reports a REFUSAL when the service answered and said no', async () => {
    // A 401 is the rotated-token shape and a 400 the stale-chat shape. Both
    // are definitive: the same message will fail again until a person acts.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 })),
    );
    expect(await sendMessage(TOKEN, CHAT, 'hello')).toBe('refused');
  });

  it('reports UNKNOWN when nothing answered at all', async () => {
    // DNS, timeout, a dropped connection. Nobody can say whether the message
    // arrived, so calling this a refusal would invent a certainty and calling
    // it a delivery would invent a different one.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    expect(await sendMessage(TOKEN, CHAT, 'hello')).toBe('unknown');
  });

  it('keeps the two failures DISTINCT — the whole point of the verdict', async () => {
    // Stated as its own case because the useful property is not what either
    // value is, but that they differ. A boolean satisfied both cases above
    // individually and still lost the distinction.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 400 })));
    const refused = await sendMessage(TOKEN, CHAT, 'hello');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const unknown = await sendMessage(TOKEN, CHAT, 'hello');
    expect(refused).not.toBe(unknown);
    expect(refused).not.toBe('accepted');
    expect(unknown).not.toBe('accepted');
  });

  it('does not put the bot token in the log when the service refuses', async () => {
    // The token is an argument in scope in that branch, and this line is
    // written precisely when something is wrong with the deployment.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await sendMessage('secret-bot-token-value', CHAT, 'hello');
    const said = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).not.toContain('secret-bot-token-value');
  });
});

describe('a NO that clears itself, versus a NO that does not', () => {
  it('calls a 429 TRANSIENT, not a refusal', async () => {
    // #2213 r26 `4015927527`. `refused` means "keeps failing until someone
    // repairs it" — that is its stated meaning in the spec and what the
    // aggregate tells an operator to act on. A rate limit repairs itself, so
    // filing it there sends someone to rotate a credential during an incident
    // that would have cleared on its own.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    expect(await sendMessage(TOKEN, CHAT, 'hello')).toBe('transient');
  });

  it('calls a 5xx TRANSIENT — the service being unwell is not our configuration', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    expect(await sendMessage(TOKEN, CHAT, 'hello')).toBe('transient');
  });

  it('still calls a 401 and a 400 REFUSED — those do need a person', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    expect(await sendMessage(TOKEN, CHAT, 'hello')).toBe('refused');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad chat', { status: 400 })));
    expect(await sendMessage(TOKEN, CHAT, 'hello')).toBe('refused');
  });

  it('keeps all FOUR apart — the property, not the individual values', async () => {
    // Each case above passes on its own while a taxonomy that collapses two
    // of them still satisfies every one. What matters is that four different
    // situations produce four different answers.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const of = async (f: () => Promise<Response>) => {
      vi.stubGlobal('fetch', vi.fn(f));
      return sendMessage(TOKEN, CHAT, 'hello');
    };
    const seen = new Set([
      await of(async () => new Response('ok', { status: 200 })),
      await of(async () => new Response('no', { status: 401 })),
      await of(async () => new Response('wait', { status: 429 })),
      await of(async () => {
        throw new Error('down');
      }),
    ]);
    expect(seen.size).toBe(4);
  });
});

