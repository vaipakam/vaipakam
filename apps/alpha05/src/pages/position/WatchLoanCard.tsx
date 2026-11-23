import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AGENT, type AgentClient } from '../../shared/alerts/agentClient';
import { useSignedRequest, type SignedRoute, type SignedRun } from '../../shared/alerts/useSignedRequest';
import {
  knownAfter,
  readKnownWatch,
  readWatchAnswer,
  watchable,
  watchBody,
  watchMessage,
  watchPath,
  writeKnownWatch,
  type KnownWatch,
  type WatchAction,
  type WatchAnswer,
} from '../../shared/alerts/watch';
import { useCopy } from '../../shared/copy/useCopy';
import { formatUtc } from '../../shared/ui/format';
import { ServiceReference } from '../../shared/ui/ServiceReference';

type Hex = `0x${string}`;
type Run = SignedRun<WatchAnswer>;

const ROUTE: SignedRoute<WatchAction, WatchAnswer> = { message: watchMessage, path: watchPath, body: watchBody, read: readWatchAnswer };

/**
 * #3769 — alerts for a running loan the reader holds neither side of
 * (FeaturesOverExistingPartsDesign.md §9). The wallet signs a message naming
 * the loan; the alert service sends Telegram alerts to the chat the wallet
 * linked on this network. Watching gives no right over the loan, and the
 * card says so. What the service holds is not shown without a signature, so
 * the card states what this browser did and that another device may differ.
 */
export function WatchLoanCard({ loanId, chainId, wallet, client = AGENT }: { loanId: bigint; chainId: number; wallet: Hex; client?: AgentClient }) {
  const { text, format } = useCopy();
  // The request's outcome is scoped to this loan too, so a watch answered
  // for one loan never shows on another loan's page.
  const { run, busy, send: sendSigned, off, who } = useSignedRequest(ROUTE, chainId, wallet, client, `loan:${loanId}`);
  // What this browser recorded for this wallet and loan: re-read whenever
  // the wallet, network or loan changes, never carried over from another.
  const scope = who;
  const [record, setRecord] = useState<{ scope: string; known: KnownWatch | null }>(() => ({ scope, known: readKnownWatch(chainId, wallet, loanId) }));
  const known = record.scope === scope ? record.known : readKnownWatch(chainId, wallet, loanId);
  const setKnown = (k: KnownWatch) => setRecord({ scope, known: k });

  const send = async (action: WatchAction) => {
    if (busy) return;
    const answer = await sendSigned(action);
    if (answer === null) return;
    const next = knownAfter(action, answer, Math.floor(Date.now() / 1000));
    if (next) {
      writeKnownWatch(chainId, wallet, loanId, next);
      setKnown(next);
    }
  };

  const tooBig = !watchable(loanId);

  return (
    <section className="home-section position-watch" aria-labelledby="position-watch" data-testid="watch-loan-card">
      <h2 id="position-watch">{text('watch.title')}</h2>
      <p className="tier-a">{text('watch.lead')}</p>
      <p className="tier-a">{text('watch.noRight')}</p>
      {off ? (
        <p className="tier-a" data-testid="watch-off">
          {text('watch.notSetUp')}
        </p>
      ) : tooBig ? (
        <p className="tier-a" data-testid="watch-too-big">
          {text('watch.tooBig')}
        </p>
      ) : (
        <>
          <p className="tier-a" data-testid="watch-known" data-state={known?.state ?? 'none'}>
            {known === null ? text('watch.knownNone') : format(known.state === 'watching' ? 'watch.knownWatching' : 'watch.knownStopped', { at: formatUtc(known.at) })}
          </p>
          <div className="position-action-row">
            <button type="button" className="btn" disabled={busy} onClick={() => void send({ kind: 'watch', loanId })} data-testid="watch-add">
              {text('watch.watch')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void send({ kind: 'unwatch', loanId })} data-testid="watch-remove">
              {text('watch.unwatch')}
            </button>
          </div>
          <p className="tier-b">{text('watch.signNote')}</p>
          <RunLine run={run} />
        </>
      )}
    </section>
  );
}

function RunLine({ run }: { run: Run }) {
  const { text, format } = useCopy();
  if (run.phase === 'idle') return null;
  if (run.phase === 'checking' || run.phase === 'signing' || run.phase === 'sending') {
    return (
      <p className="tier-b" role="status" data-testid="watch-run">
        {text(run.phase === 'sending' ? 'watch.sending' : 'watch.signing')}
      </p>
    );
  }
  if (run.phase === 'declined') return <p className="tier-b" data-testid="watch-run">{text('watch.declined')}</p>;
  if (run.phase === 'not-offered') return <p className="tier-a" data-testid="watch-run" data-offered="false">{text('watch.notOffered')}</p>;
  if (run.phase === 'unreachable')
    return (
      <p className="tier-a" data-testid="watch-run">
        {format('watch.unreachable', { reason: run.message })}
        <ServiceReference reference={run.reference} />
      </p>
    );
  if (run.phase !== 'answered') return null;
  const a = run.answer;
  if (a.ok && a.kind === 'watch') {
    return (
      <div data-testid="watch-run" data-outcome="watching">
        <p className="tier-b">{text(a.already ? 'watch.already' : 'watch.watching')}</p>
        {!a.telegramLinked && (
          <p className="tier-a" data-testid="watch-no-telegram">
            {text('watch.noTelegram')} <Link to="/alerts">{text('watch.linkTelegram')}</Link>
          </p>
        )}
      </div>
    );
  }
  if (a.ok) {
    return (
      <p className="tier-b" data-testid="watch-run" data-outcome="stopped">
        {text('watch.stopped')}
      </p>
    );
  }
  const line = (() => {
    switch (a.problem) {
      case 'used':
        return text('watch.used');
      case 'refused':
        return text('watch.refused');
      case 'verify-down':
        return text('watch.verifyDown');
      case 'chain-not-served':
        return text('watch.chainNotServed');
      case 'loan-unreadable':
        return text('watch.loanUnreadable');
      case 'loan-not-found':
        return text('watch.loanNotFound');
      case 'loan-not-active':
        return text('watch.loanNotActive');
      case 'holds-a-position':
        return text('watch.holdsPosition');
      case 'too-many-loans':
        return a.limit === null ? text('watch.tooManyUnstated') : format('watch.tooMany', { limit: String(a.limit) });
      case 'changes-spent':
        return a.limit === null ? text('watch.changesSpentUnstated') : format('watch.changesSpent', { limit: String(a.limit) });
      case 'not-watching':
        return text('watch.notWatching');
      default:
        return format('watch.other', { status: String(a.status) });
    }
  })();
  return (
    <p className="tier-a" data-testid="watch-run" data-outcome={a.problem}>
      {line}
      <ServiceReference reference={run.reference} />
    </p>
  );
}
