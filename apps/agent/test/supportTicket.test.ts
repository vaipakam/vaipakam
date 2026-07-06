/** #1040 phase 1 — POST /support/ticket handler + validator. The D1
 *  and Telegram sides are stubbed at their seams (a fake DB whose
 *  prepare/bind/run records the insert; a fetch spy for the ops
 *  notify) so the suite pins the endpoint's CONTRACT: validation
 *  shapes, the durable-row-before-notify ordering, the honest 503
 *  when D1 fails, and the notify-skip when the ops bot is unset. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleSupportTicket,
  newTicketId,
  notifyOpsNewTicket,
  parseSupportTicket,
} from '../src/supportTicket';
import type { Env } from '../src/env';

function fakeDb(opts: { failInsert?: boolean } = {}) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              calls.push({ sql, args });
              if (opts.failInsert) throw new Error('no such table');
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

function envWith(overrides: Partial<Env>): Env {
  return {
    DB: fakeDb().db,
    FRONTEND_ORIGIN: 'https://alpha02.vaipakam.com',
    ...overrides,
  } as Env;
}

/** Fake ExecutionContext capturing waitUntil promises so the suite
 *  can await the post-response notify deterministically. */
function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    pending,
  };
}

const req = (body: unknown) =>
  new Request('https://agent.example/support/ticket', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parseSupportTicket', () => {
  it('accepts a minimal message-only body', () => {
    expect(parseSupportTicket({ message: 'help' })).toEqual({
      message: 'help',
      email: null,
      diagnostics: null,
      page: null,
      chainId: null,
    });
  });

  it('rejects empty, missing, and oversized messages', () => {
    expect(parseSupportTicket({})).toBeNull();
    expect(parseSupportTicket({ message: '   ' })).toBeNull();
    expect(parseSupportTicket({ message: 'x'.repeat(2001) })).toBeNull();
    expect(parseSupportTicket('help')).toBeNull();
    expect(parseSupportTicket(null)).toBeNull();
  });

  it('rejects malformed emails but treats empty as absent', () => {
    expect(parseSupportTicket({ message: 'm', email: 'not-an-email' })).toBeNull();
    expect(parseSupportTicket({ message: 'm', email: 42 })).toBeNull();
    expect(parseSupportTicket({ message: 'm', email: '' })?.email).toBeNull();
    expect(
      parseSupportTicket({ message: 'm', email: ' a@b.co ' })?.email,
    ).toBe('a@b.co');
  });

  it('caps diagnostics server-side and marks the truncation', () => {
    const parsed = parseSupportTicket({
      message: 'm',
      diagnostics: 'd'.repeat(5000),
    });
    expect(parsed?.diagnostics?.length).toBeLessThan(4200);
    expect(parsed?.diagnostics?.endsWith('[truncated]')).toBe(true);
  });

  it('rejects non-positive or fractional chain ids', () => {
    expect(parseSupportTicket({ message: 'm', chainId: 0 })).toBeNull();
    expect(parseSupportTicket({ message: 'm', chainId: 1.5 })).toBeNull();
    expect(parseSupportTicket({ message: 'm', chainId: '84532' })).toBeNull();
    expect(parseSupportTicket({ message: 'm', chainId: 84532 })?.chainId).toBe(84532);
  });
});

describe('newTicketId', () => {
  it('mints prefixed, distinct ids', () => {
    const a = newTicketId();
    const b = newTicketId();
    expect(a).toMatch(/^VPK-[A-Z0-9]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe('handleSupportTicket', () => {
  it('inserts the row and returns the ticket id (no notify when ops bot unset)', async () => {
    const { db, calls } = fakeDb();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { ctx, pending } = fakeCtx();
    const res = await handleSupportTicket(
      req({ message: 'something broke', chainId: 84532, page: '/lend' }),
      envWith({ DB: db }),
      'https://alpha02.vaipakam.com',
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticketId: string };
    expect(body.ticketId).toMatch(/^VPK-/);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe(body.ticketId);
    // Two-bot policy: with TG_OPS_* unset the notify is skipped —
    // and the USER bot is never a fallback.
    await Promise.all(pending);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('notifies the ops bot when configured — AFTER the response, via waitUntil', async () => {
    const { db, calls } = fakeDb();
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { ctx, pending } = fakeCtx();
    const res = await handleSupportTicket(
      req({ message: 'm'.repeat(400), diagnostics: 'block' }),
      envWith({ DB: db, TG_OPS_BOT_TOKEN: 'ops-token', TG_OPS_CHAT_ID: '42' }),
      'https://alpha02.vaipakam.com',
      ctx,
    );
    // The response never waits on Telegram (Codex round-1 P2): the
    // notify is HANDED OFF to waitUntil rather than awaited inline.
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/botops-token/sendMessage');
    const sent = JSON.parse(String(init.body)) as { chat_id: string; text: string };
    expect(sent.chat_id).toBe('42');
    expect(sent.text).toContain('diagnostics: attached');
    // Metadata only — the user's words never travel to Telegram
    // (third-party disclosure boundary); the full text lives in D1.
    expect(sent.text).not.toContain('m'.repeat(50));
    expect(sent.text.length).toBeLessThan(300);
  });

  it('the response resolves even when Telegram stalls (notify decoupled)', async () => {
    const { db } = fakeDb();
    // A never-resolving Telegram send must not block the response.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    const { ctx } = fakeCtx();
    const res = await handleSupportTicket(
      req({ message: 'slow telegram' }),
      envWith({ DB: db, TG_OPS_BOT_TOKEN: 't', TG_OPS_CHAT_ID: '1' }),
      'https://alpha02.vaipakam.com',
      ctx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ticketId: string }).ticketId).toMatch(/^VPK-/);
  });

  it('notifyOpsNewTicket never throws on a failed send', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(
      notifyOpsNewTicket(
        envWith({ TG_OPS_BOT_TOKEN: 't', TG_OPS_CHAT_ID: '1' }),
        'VPK-X',
        { message: 'm', email: null, diagnostics: null, page: null, chainId: null },
      ),
    ).resolves.toBeUndefined();
  });

  it('returns an honest 503 when the insert fails (migration not applied)', async () => {
    const { db } = fakeDb({ failInsert: true });
    const res = await handleSupportTicket(
      req({ message: 'm' }),
      envWith({ DB: db, TG_OPS_BOT_TOKEN: 't', TG_OPS_CHAT_ID: '1' }),
      'https://alpha02.vaipakam.com',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('rejects invalid bodies with 400 and rate-limited callers with 429', async () => {
    const bad = await handleSupportTicket(
      req({ message: '' }),
      envWith({}),
      'https://alpha02.vaipakam.com',
    );
    expect(bad.status).toBe(400);

    const limited = await handleSupportTicket(
      req({ message: 'm' }),
      envWith({
        SUPPORT_TICKET_RATELIMIT: {
          limit: async () => ({ success: false }),
        },
      }),
      'https://alpha02.vaipakam.com',
    );
    expect(limited.status).toBe(429);
  });
});
