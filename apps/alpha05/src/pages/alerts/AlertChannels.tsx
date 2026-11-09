import { useState, type FormEvent } from 'react';
import { useMode } from '../../app/ModeContext';
import { SUPPORTED_CHAINS, type SupportedChain } from '../../chain/chains';
import { useOwnStateClient } from '../../chain/ownRail';
import { AGENT } from '../../shared/alerts/agentClient';
import { bandsProblem, DEFAULT_BANDS, parseBand, pushChannelUrl, type AlertAction, type Bands } from '../../shared/alerts/alerts';
import { type KnownAlerts } from '../../shared/alerts/known';
import { useKnown } from '../../shared/alerts/useKnown';
import { useAlertAction, type AlertRun } from '../../shared/alerts/useAlertAction';
import { usePushStatus } from '../../shared/alerts/usePushStatus';
import { useCopy, type CopyAccess, type CopyKey } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { formatUtc, shortAddress } from '../../shared/ui/format';
import { useStoredValue } from '../../shared/tx/txStore';
import { Notice } from '../../shared/ui/Notice';
import { useNow } from '../../shared/ui/useNow';

type Hex = `0x${string}`;


/** The sign-ups the Terms gate holds: linking Telegram and switching push on.
 *  Switching anything off is never gated (ACC-15). */
type GatedAction = 'link' | 'push';

/**
 * Alerts › Channels and preferences (#3180 Alerts slice 2, ACC-50 / ACC-52;
 * RB-ALERT-CHANNELS). Telegram is linked with a one-time code, proven by a
 * test alert, and unlinked; push is offered only when the alert service says
 * it can send now; health warnings are always on once a channel is set up,
 * with their three lines fixed in Basic and editable in Advanced; payment
 * due-date reminders switch on and off. Every change is signed in the
 * wallet, costs nothing, and carries only what it changes.
 *
 * The service does not say what it has stored, so each card states what
 * this browser has done and that a link or setting made elsewhere may
 * exist. Mounted per wallet and network (the page keys it), so nothing
 * shown belongs to another identity.
 */
export function AlertChannels({ chain, account }: { chain: SupportedChain; account: Hex }) {
  const { text } = useCopy();
  if (AGENT.origin === null) {
    return (
      <section className="home-section" aria-labelledby="alert-channels" data-testid="alert-channels">
        <h2 id="alert-channels">{text('alertChannels.title')}</h2>
        <p className="tier-a" data-testid="alert-channels-off">
          {text('alertChannels.notSetUp')}
        </p>
      </section>
    );
  }
  return <ChannelsBody chain={chain} account={account} />;
}

function ChannelsBody({ chain, account }: { chain: SupportedChain; account: Hex }) {
  const copy = useCopy();
  const { text, format } = copy;
  const { isAdvanced } = useMode();
  const own = useOwnStateClient();
  const terms = useTerms();
  const termsGate = useTermsGate('alerts.channels.terms', chain, own);
  // The action the Terms prompt was opened for, kept in the app's
  // transaction store beside the prompt's own session, so a reader who
  // leaves the page mid-acceptance comes back to the same action.
  const [follow, setFollow] = useStoredValue<GatedAction>(`alerts.channels.follow:${chain.chainId}:${account.toLowerCase()}`);
  const known = useKnown(chain.chainId, account);
  const action = useAlertAction(chain.chainId, account);
  const nowS = Math.floor(useNow(5_000) / 1000);

  const push = usePushStatus();
  const pushNow = push.current;

  const run = async (a: AlertAction) => {
    await action.start(a);
  };
  const code = action.code;

  const gated = (g: GatedAction) => {
    if (terms.data?.kind === 'needed') {
      setFollow(g);
      termsGate.start(terms.data);
      return;
    }
    void run(g === 'link' ? 'link' : { save: { pushAlerts: true } });
  };
  const termsUnknown = terms.state === 'failed';
  const signUpBlocked = action.busy || terms.state !== 'ready' || termsGate.session !== null;

  const codeLive = code !== null && code.expiresAt > nowS;
  const tg = known.telegram;
  const held = known.held?.pending ?? [];
  const bands: Bands = known.bands ?? DEFAULT_BANDS;

  return (
    <section className="home-section alert-channels" aria-labelledby="alert-channels" data-testid="alert-channels">
      <h2 id="alert-channels">{text('alertChannels.title')}</h2>
      <p className="tier-b">{text('alertChannels.lead')}</p>
      <p className="tier-a">{text('alertChannels.stored')}</p>
      <p className="tier-b">{text('alertChannels.thisBrowser')}</p>
      {termsUnknown && (
        <Notice tone="warn" tier="A">
          {format('consent.termsUnknown', { chain: chain.name, reason: terms.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={terms.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {termsGate.session && own && (
        <TermsPrompt
          asker={text(follow === 'push' ? 'alertChannels.askerPush' : 'alertChannels.askerLink')}
          gate={termsGate}
          session={termsGate.session}
          chain={chain}
          own={own}
          onAccepted={() => {
            termsGate.end();
            const f = follow;
            setFollow(null);
            if (f) void run(f === 'link' ? 'link' : { save: { pushAlerts: true } });
          }}
          onClose={() => {
            termsGate.end();
            setFollow(null);
          }}
        />
      )}
      <RunLine run={action.run} chain={chain} copy={copy} />

      <div className="card alert-channel" data-testid="alert-telegram">
        <h3>{text('alertChannels.telegramTitle')}</h3>
        {codeLive ? (
          <div data-testid="alert-telegram-code">
            <p className="tier-b">{format('alertChannels.codeLead', { time: formatUtc(code.expiresAt) })}</p>
            <p className="alert-code">
              <code data-testid="alert-telegram-code-value">{code.code}</code>
            </p>
            {code.botUrl ? (
              <p>
                <a className="btn btn-primary" href={code.botUrl} target="_blank" rel="noreferrer" data-testid="alert-telegram-bot">
                  {text('alertChannels.openBot')}
                </a>
              </p>
            ) : (
              <p className="tier-b">{text('alertChannels.noBotLink')}</p>
            )}
            <p className="tier-b">{text('alertChannels.thenTest')}</p>
          </div>
        ) : (
          <p className="tier-b" data-testid="alert-telegram-state">
            {telegramLine(tg, held.length > 0, chain, nowS, copy)}
          </p>
        )}
        {held.map((p) => (
            <p key={p.chainId} className="tier-a" data-testid="alert-telegram-pending">
              {p.effectiveAt === null
                ? format('alertChannels.unlinkPendingUntold', { chain: chainName(p.chainId) })
                : format('alertChannels.unlinkPending', { chain: chainName(p.chainId), time: formatUtc(p.effectiveAt) })}
            </p>
          ))}
        <div className="form-actions">
          {!codeLive && (
            <button type="button" className="btn btn-primary" disabled={signUpBlocked} onClick={() => gated('link')} data-testid="alert-telegram-link">
              {text(tg?.state === 'confirmed' ? 'alertChannels.linkAgain' : 'alertChannels.link')}
            </button>
          )}
          <button type="button" className={codeLive ? 'btn btn-primary' : 'btn'} disabled={action.busy} onClick={() => void run('test-alert')} data-testid="alert-telegram-test">
            {text('alertChannels.test')}
          </button>
          <button type="button" className="btn" disabled={action.busy} onClick={() => void run('unlink')} data-testid="alert-telegram-unlink">
            {text('alertChannels.unlink')}
          </button>
        </div>
      </div>

      <div className="card alert-channel" data-testid="alert-push">
        <h3>{text('alertChannels.pushTitle')}</h3>
        {push.state === 'pending' && <p className="tier-b">{text('alertChannels.pushChecking')}</p>}
        {push.state === 'error' && (
          <p className="tier-b" data-testid="alert-push-unknown">
            {format('alertChannels.pushUnknown', { reason: push.error ?? '' })}
          </p>
        )}
        {pushNow?.kind === 'available' && (
          <>
            <p className="tier-b" data-testid="alert-push-available">
              {format('alertChannels.pushAvailable', { channel: shortAddress(pushNow.channel) })}
            </p>
            {pushNow.scope === 'agent' && (
              <p className="tier-a" data-testid="alert-push-scope">
                {text('alertChannels.pushRemindersOnly')}
              </p>
            )}
            {known.push ? (
              <p className="tier-b" data-testid="alert-push-on">
                {format('alertChannels.pushOnHere', { time: formatUtc(known.push.at) })}
              </p>
            ) : (
              <button type="button" className="btn btn-primary" disabled={signUpBlocked} onClick={() => gated('push')} data-testid="alert-push-enable">
                {text('alertChannels.pushEnable')}
              </button>
            )}
            <p className="tier-b">
              {text('alertChannels.pushSubscribe')}{' '}
              <a href={pushChannelUrl(pushNow.channel)} target="_blank" rel="noreferrer" data-testid="alert-push-channel">
                {text('alertChannels.pushChannelLink')}
              </a>
            </p>
            <p className="tier-b">{text('alertChannels.pushOff')}</p>
          </>
        )}
        {pushNow?.kind === 'unavailable' && (
          <>
            <p className="tier-b" data-testid="alert-push-unavailable" data-reason={pushNow.reason}>
              {text('alertChannels.pushUnavailable')} {pushReason(pushNow.reason, copy)}
              {pushNow.rail && ` ${text(pushNow.rail === 'agent' ? 'alertChannels.pushRailAgent' : 'alertChannels.pushRailKeeper')}`}
            </p>
            {PUSH_SETUP_REASONS[pushNow.reason] && <p className="tier-b">{text('alertChannels.pushSetup')}</p>}
            {known.push && <p className="tier-b">{text('alertChannels.pushKept')}</p>}
          </>
        )}
      </div>

      <div className="card alert-channel" data-testid="alert-health">
        <h3>{text('alertChannels.healthTitle')}</h3>
        <p className="tier-b">{text('alertChannels.healthAlways')}</p>
        <p className="tier-b" data-testid="alert-health-bands">
          {format('alertChannels.healthBands', { warn: String(bands.warnHf), alert: String(bands.alertHf), critical: String(bands.criticalHf) })}{' '}
          {known.bands ? format('alertChannels.savedHere', { time: formatUtc(known.bands.at) }) : text('alertChannels.healthDefault')}
        </p>
        <p className="tier-a">{text('alertChannels.healthNoPromise')}</p>
        {isAdvanced && <BandsForm initial={bands} busy={action.busy} onSave={(b) => void run({ save: { bands: b } })} copy={copy} />}
      </div>

      <div className="card alert-channel" data-testid="alert-due">
        <h3>{text('alertChannels.dueTitle')}</h3>
        <p className="tier-b" data-testid="alert-due-state">
          {known.dueDate
            ? format(known.dueDate.on ? 'alertChannels.dueOnHere' : 'alertChannels.dueOffHere', { time: formatUtc(known.dueDate.at) })
            : text('alertChannels.dueDefault')}
        </p>
        <button
          type="button"
          className="btn"
          disabled={action.busy}
          onClick={() => void run({ save: { dueDateReminders: known.dueDate?.on === false } })}
          data-testid="alert-due-toggle"
        >
          {text(known.dueDate?.on === false ? 'alertChannels.dueSwitchOn' : 'alertChannels.dueSwitchOff')}
        </button>
      </div>
      <WhyLink summaryKey="alertChannels.whySummary" detailKey="alertChannels.why" />
    </section>
  );
}

/** The configuration problems the alert service names when push cannot be
 *  offered (the service's own reason codes); each is a setting of this
 *  deployment, said as such, never shown as a passing outage. */
const PUSH_SETUP_REASONS: Readonly<Record<string, CopyKey>> = {
  'signer-unset': 'alertChannels.pushReasonSignerUnset',
  'signer-malformed': 'alertChannels.pushReasonSignerMalformed',
  'signer-unsupported': 'alertChannels.pushReasonSignerUnsupported',
  'channel-malformed': 'alertChannels.pushReasonChannelMalformed',
  'channel-mismatch': 'alertChannels.pushReasonChannelMismatch',
};

function pushReason(reason: string, { text, format }: CopyAccess): string {
  const key = PUSH_SETUP_REASONS[reason];
  return key ? text(key) : format('alertChannels.pushReasonOther', { reason });
}

function chainName(id: number): string {
  return SUPPORTED_CHAINS.find((c) => c.chainId === id)?.name ?? `network ${id}`;
}

function telegramLine(tg: KnownAlerts['telegram'], holds: boolean, chain: SupportedChain, nowS: number, { text, format }: CopyAccess): string {
  if (!tg) return format('alertChannels.telegramNone', { chain: chain.name });
  if (tg.state === 'confirmed') return format('alertChannels.telegramConfirmed', { time: formatUtc(tg.at) });
  if (tg.state === 'code') return format(tg.expiresAt > nowS ? 'alertChannels.telegramCodeHere' : 'alertChannels.telegramCodeOld', { time: formatUtc(tg.at) });
  if (tg.scope === 'wallet') return format(holds ? 'alertChannels.telegramUnlinkedWalletHeld' : 'alertChannels.telegramUnlinkedWallet', { time: formatUtc(tg.at) });
  return text('alertChannels.telegramUnlinkedChain') + ' ' + format('alertChannels.unlinkedAt', { chain: chain.name, time: formatUtc(tg.at) });
}

function BandsForm({ initial, busy, onSave, copy }: { initial: Bands; busy: boolean; onSave: (b: Bands) => void; copy: CopyAccess }) {
  const { text } = copy;
  const [warn, setWarn] = useState(String(initial.warnHf));
  const [alert, setAlert] = useState(String(initial.alertHf));
  const [critical, setCritical] = useState(String(initial.criticalHf));
  const bands: Bands = { warnHf: parseBand(warn), alertHf: parseBand(alert), criticalHf: parseBand(critical) };
  const problem = bandsProblem(bands);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem === null) onSave(bands);
  };
  return (
    <form className="alert-bands" onSubmit={submit} data-testid="alert-bands-form">
      <p className="tier-b">{text('alertChannels.bandsLead')}</p>
      <div className="alert-bands-row">
        <label>
          {text('alertChannels.bandWarn')}
          <input inputMode="decimal" value={warn} onChange={(e) => setWarn(e.target.value)} data-testid="alert-band-warn" />
        </label>
        <label>
          {text('alertChannels.bandAlert')}
          <input inputMode="decimal" value={alert} onChange={(e) => setAlert(e.target.value)} data-testid="alert-band-alert" />
        </label>
        <label>
          {text('alertChannels.bandCritical')}
          <input inputMode="decimal" value={critical} onChange={(e) => setCritical(e.target.value)} data-testid="alert-band-critical" />
        </label>
      </div>
      {problem !== null && (
        <p className="tier-b" data-testid="alert-bands-problem">
          {text(`alertChannels.bands_${problem}` as CopyKey)}
        </p>
      )}
      <button type="submit" className="btn" disabled={busy || problem !== null} data-testid="alert-bands-save">
        {text('alertChannels.bandsSave')}
      </button>
    </form>
  );
}

/** What the last signed action did, in words: the run's phase, or the
 *  service's answer, or why nothing changed. */
function RunLine({ run, chain, copy }: { run: AlertRun; chain: SupportedChain; copy: CopyAccess }) {
  if (run.phase === 'idle') return null;
  const [tone, line] = runWords(run, chain, copy);
  return (
    <div data-testid="alert-run" data-phase={run.phase} data-problem={run.phase === 'answered' && !run.answer.ok ? run.answer.problem : ''}>
      <Notice tone={tone} tier={tone === 'warn' ? 'A' : 'B'}>
        {line}
      </Notice>
    </div>
  );
}

function runWords(run: Exclude<AlertRun, { phase: 'idle' }>, chain: SupportedChain, { text, format }: CopyAccess): ['info' | 'ok' | 'warn', string] {
  switch (run.phase) {
    case 'signing':
      return ['info', text('alertChannels.signing')];
    case 'sending':
      return ['info', text('alertChannels.sending')];
    case 'declined':
      return ['warn', text('alertChannels.declined')];
    case 'unreachable':
      return ['warn', format('alertChannels.unreachable', { reason: run.message })];
    case 'answered': {
      const a = run.answer;
      if (!a.ok) {
        return [
          'warn',
          a.problem === 'other'
            ? format('alertChannels.problem_other', { status: String(a.status) })
            : format(`alertChannels.problem_${a.problem}` as CopyKey, { chain: chain.name }),
        ];
      }
      if (a.action === 'link') return ['ok', text('alertChannels.doneLink')];
      if (a.action === 'test-alert') return ['ok', text('alertChannels.doneTest')];
      if (a.action === 'unlink') {
        if (a.pending.length > 0) return ['ok', text(a.scope === 'wallet' ? 'alertChannels.doneUnlinkWalletHeld' : 'alertChannels.doneUnlinkChainHeld')];
        return ['ok', a.scope === 'wallet' ? text('alertChannels.doneUnlinkWallet') : format('alertChannels.doneUnlinkChain', { chain: chain.name })];
      }
      return ['ok', text(a.push === 'kept' ? 'alertChannels.doneSaveKept' : 'alertChannels.doneSave')];
    }
  }
}
