/**
 * Support-ticket client (#1040 phase 1) — talks ONLY to Vaipakam's
 * own agent Worker (no third-party chat SaaS: cost, CSP posture, and
 * the no-tracker privacy stance all point the same way).
 *
 * Mirrors the alerts client's posture (`data/alerts.ts`): the Worker
 * origin comes from VITE_AGENT_ORIGIN, and when it isn't configured
 * the surface says so honestly and offers the mailto path instead of
 * silently pointing at another environment's backend.
 */

const TIMEOUT_MS = 8_000;

export const SUPPORT_EMAIL = 'support@vaipakam.com';

function agentOrigin(): string | null {
  const raw = import.meta.env.VITE_AGENT_ORIGIN as string | undefined;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export function supportConfigured(): boolean {
  return agentOrigin() !== null;
}

export interface SupportTicketInput {
  message: string;
  email: string | null;
  /** Pre-redacted self-diagnostics block — only ever passed after
   *  the user's explicit attach consent. */
  diagnostics: string | null;
  page: string | null;
  chainId: number | null;
}

/** Error subtype so the card can choose plain-words copy per cause
 *  (rate-limited vs inbox-down vs generic) — every branch still ends
 *  at the always-available mailto fallback. */
export class SupportTicketError extends Error {
  readonly kind: 'rate_limited' | 'unavailable' | 'failed';
  constructor(
    kind: 'rate_limited' | 'unavailable' | 'failed',
    message: string,
  ) {
    super(message);
    this.kind = kind;
  }
}

export async function submitSupportTicket(
  input: SupportTicketInput,
): Promise<{ ticketId: string }> {
  const origin = agentOrigin();
  if (!origin) throw new SupportTicketError('unavailable', 'not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/support/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    if (res.status === 429) {
      throw new SupportTicketError('rate_limited', 'rate limited');
    }
    if (res.status === 503) {
      throw new SupportTicketError('unavailable', 'inbox unavailable');
    }
    if (!res.ok) {
      throw new SupportTicketError('failed', `submit failed (${res.status})`);
    }
    const body = (await res.json()) as { ticketId?: unknown };
    if (typeof body.ticketId !== 'string' || body.ticketId === '') {
      throw new SupportTicketError('failed', 'malformed response');
    }
    return { ticketId: body.ticketId };
  } catch (e) {
    if (e instanceof SupportTicketError) throw e;
    throw new SupportTicketError('failed', 'network failure');
  } finally {
    clearTimeout(t);
  }
}

/** Prefilled escalation mail. Deliberately NOT carrying the full
 *  diagnostics block: when a ticket exists the block is already
 *  stored under the ticket id, and mailto URLs get truncated by mail
 *  clients — a reference number survives where a wall of text
 *  doesn't. */
export function supportMailto(opts: {
  ticketId?: string;
  message?: string;
}): string {
  const subject = opts.ticketId
    ? `Vaipakam support — ticket ${opts.ticketId}`
    : 'Vaipakam support';
  const lines = [
    opts.ticketId
      ? `My ticket number: ${opts.ticketId} (diagnostics already attached to it)`
      : null,
    '',
    opts.message?.slice(0, 1_000) ?? '',
  ].filter((l): l is string => l !== null);
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}
