/**
 * Contact-support section of the Support drawer (#1040 phase 1).
 *
 * Ticket capture without an LLM: the user writes what happened, may
 * attach the drawer's self-diagnostics with ONE explicit consent
 * click (never silently), and gets a ticket number back. Escalation
 * to a human is a prefilled mailto carrying the ticket number — the
 * D1 row plus the ops-Telegram notify guarantee the team sees the
 * report even if the mail is never sent.
 *
 * Honesty rules carried from the alerts card:
 *  - no configured backend → say so and offer the mailto path, never
 *    point at another environment's Worker;
 *  - every failure branch names its cause in plain words and ends at
 *    the always-available mailto fallback;
 *  - what sending stores is stated next to the send button, before
 *    anything is sent.
 */
import { useState } from 'react';
import { copy } from '../content/copy';
import {
  submitSupportTicket,
  supportConfigured,
  supportMailto,
  SupportTicketError,
} from '../data/support';
import {
  buildReportBody,
  redactCap,
  type ReportContext,
} from '../diagnostics/reportIssue';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SupportTicketCard({
  reportCtx,
  chainId,
}: {
  reportCtx: ReportContext;
  chainId: number | null;
}) {
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [attach, setAttach] = useState(false);
  const [sending, setSending] = useState(false);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!supportConfigured()) {
    return (
      <section style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 4 }}>{copy.support.title}</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          {copy.support.notConfigured}
        </p>
        <a className="btn btn-secondary" href={supportMailto({})}>
          {copy.support.mailButton}
        </a>
      </section>
    );
  }

  if (ticketId !== null) {
    return (
      <section style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 4 }}>{copy.support.title}</h3>
        <p>{copy.support.sent(ticketId)}</p>
        <p className="muted" style={{ fontSize: 13 }}>
          {copy.support.mailHint}
        </p>
        <a
          className="btn btn-secondary"
          href={supportMailto({ ticketId, message, diagnosticsAttached: attach })}
        >
          {copy.support.mailButton}
        </a>
      </section>
    );
  }

  const send = async () => {
    const trimmed = message.trim();
    if (trimmed === '') {
      setError(copy.support.invalidMessage);
      return;
    }
    const replyEmail = email.trim();
    if (replyEmail !== '' && !EMAIL_SHAPE.test(replyEmail)) {
      setError(copy.support.invalidEmail);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const { ticketId: id } = await submitSupportTicket({
        message: trimmed.slice(0, 2_000),
        email: replyEmail === '' ? null : replyEmail,
        // The attach consent gates the ONLY non-user-typed content;
        // buildReportBody is the same redacted block the GitHub
        // report path uses (full wallet address never included).
        diagnostics: attach ? buildReportBody(reportCtx) : null,
        // Same scrubber as the GitHub report path (Codex round-1 P2):
        // a deep-linked URL can carry a full wallet address in its
        // query, and `page` travels regardless of the diagnostics
        // consent — redact + cap before it leaves the device.
        page: redactCap(reportCtx.path, 200),
        chainId,
      });
      setTicketId(id);
    } catch (e) {
      const kind = e instanceof SupportTicketError ? e.kind : 'failed';
      setError(
        kind === 'rate_limited'
          ? copy.support.rateLimited
          : kind === 'unavailable'
            ? copy.support.unavailable
            : copy.support.failed,
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <section style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 4 }}>{copy.support.title}</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {copy.support.lede}
      </p>
      <div className="field">
        <label htmlFor="support-message">{copy.support.messageLabel}</label>
        <textarea
          id="support-message"
          className="input"
          rows={4}
          maxLength={2_000}
          placeholder={copy.support.messagePlaceholder}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="support-email">{copy.support.emailLabel}</label>
        <input
          id="support-email"
          className="input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
          {copy.support.emailHint}
        </p>
      </div>
      <label
        style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}
      >
        <input
          type="checkbox"
          checked={attach}
          onChange={(e) => setAttach(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>{copy.support.attach}</span>
      </label>
      <p className="muted" style={{ fontSize: 12 }}>
        {copy.support.privacy}
      </p>
      {error !== null ? (
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">
            {error}{' '}
            {/* EVERY failure branch ends at the mail path — a user
                behind a shared NAT hitting the per-IP cap must not be
                stranded on "wait a minute" (Codex round-1 P3). */}
            <a href={supportMailto({ message })}>{copy.support.mailButton}</a>
          </span>
        </div>
      ) : null}
      <button
        type="button"
        className="btn btn-primary"
        disabled={sending}
        onClick={() => void send()}
      >
        {sending ? copy.support.sending : copy.support.send}
      </button>
    </section>
  );
}
