/**
 * What the keeper would have told its operators. A scenario runs with no ops
 * bot configured, so every alert or notice a pass raises is logged as "NOT
 * delivered" (`src/opsAlert.ts`) and nothing leaves the machine; this
 * collects those lines so a scenario can assert on them — a pass that did its
 * job raises no fault alert, and one that moved value states the amounts.
 */
import { vi } from 'vitest';

const MARKER = '[keeper] ops alert NOT delivered';

export interface OpsAlertLog {
  /** The alert texts, in order. */
  readonly texts: string[];
  /** Drop what has been collected so far. */
  clear(): void;
}

export function collectOpsAlerts(): OpsAlertLog {
  const texts: string[] = [];
  const original = console.warn.bind(console);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith(MARKER)) texts.push(line.slice(line.indexOf('):') + 2).trim());
    original(...args);
  });
  return {
    texts,
    clear() {
      texts.length = 0;
    },
  };
}

/** What a scenario's stand-in ops bot was asked to post. */
export interface OpsBotSink {
  /** The env entries that configure the keeper's ops bot to post to the sink. */
  readonly env: { TG_OPS_BOT_TOKEN: string; TG_OPS_CHAT_ID: string };
  /** The texts posted, in order. */
  readonly posts: string[];
  clear(): void;
}

const TELEGRAM_ORIGIN = 'https://api.telegram.org';

/**
 * A stand-in for the operators' Telegram chat, for a scenario that must see
 * an alert RECORDED and then CLEARED — which only a configured bot does: an
 * unconfigured one ({@link collectOpsAlerts}) logs each alert and records
 * nothing, so it has nothing to clear. The keeper is configured with a
 * placeholder bot token and chat, and its one request to the Telegram API
 * is answered here with success and recorded; every other request (the
 * nodes' RPC) goes through untouched. No request leaves the machine.
 */
export function opsBotSink(): OpsBotSink {
  const posts: string[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${TELEGRAM_ORIGIN}/`)) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
    posts.push(String(body.text ?? ''));
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch);
  return {
    env: { TG_OPS_BOT_TOKEN: 'keeper-e2e-placeholder-token', TG_OPS_CHAT_ID: 'keeper-e2e-ops-chat' },
    posts,
    clear() {
      posts.length = 0;
    },
  };
}
