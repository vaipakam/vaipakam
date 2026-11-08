import { useState, type FormEvent } from 'react';
import { useMode } from '../../app/ModeContext';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { useOwnRead } from '../reads/useOwnRead';
import { FormField } from '../ui/FormField';
import { Notice } from '../ui/Notice';
import { OwnStamp } from '../ui/OwnStamp';
import { formatSpan, formatUtc, shortAddress } from '../ui/format';
import { useNow } from '../ui/useNow';
import { PayoutQueue } from './PayoutQueue';
import { CHANGE_WORDS, dueChanges, pendingChanges, readSafetyFacts, safetyClock, type SafetyAction, type SafetyDraft, type SafetyMode } from './safety';
import { SafetyActionFlow, useSafetyHeld } from './SafetyAction';

const DAY = 86_400;

/**
 * ACC-36 (Basic face) — the Vault page's safety card: whether the account
 * runs protected mode, its delay, whether it is locked and by whom, what
 * waits in its payout queue, and every change still pending, read at one
 * block; with the safety actions Basic mode offers (turn it on, lock now,
 * ask to unlock, apply the changes that are due). A Diamond without the
 * feature says "unavailable", never "off"; an unread mode offers no control.
 * The full Protection page (destinations, signers, replacement) is Advanced
 * and comes later; the card says so.
 */
export function SafetyCard({ own, chain }: { own: OwnStateClient; chain: SupportedChain }) {
  const { text, format } = useCopy();
  const diamond = chain.diamondAddress;
  const wallet = own.account;
  const facts = useOwnRead(['safety', diamond, wallet], (c) => readSafetyFacts(c, diamond, wallet), { perBlock: true });
  const held = useSafetyHeld();
  const [choosing, setChoosing] = useState(false);
  const nowMs = useNow(1000);
  const f = facts.data;
  const m = f?.mode;

  const open = (action: SafetyAction, draft: SafetyDraft | null = null) => {
    setChoosing(false);
    held.open({ action, draft });
  };
  const close = () => {
    held.open(null);
    facts.refetch();
  };

  const body = (() => {
    if (f === null || f === undefined) {
      return facts.state === 'failed' ? (
        <p className="tier-a" data-testid="vault-safety-unread">
          {format('safety.cardUnread', { reason: facts.error ?? '' })}
        </p>
      ) : (
        <p className="tier-b">{text('flow.reading')}</p>
      );
    }
    if (m === 'absent')
      return (
        <p className="tier-a" data-testid="vault-safety-unavailable">
          {text('safety.cardUnavailable')}
        </p>
      );
    if (m === null || m === undefined)
      return (
        <p className="tier-a" data-testid="vault-safety-unread">
          {text('safety.cardModeUnread')}
        </p>
      );
    if (m.retired)
      return (
        <p className="tier-a" data-testid="vault-safety-retired">
          {format('safety.cardRetired', { address: shortAddress(m.controller) })}
        </p>
      );
    const now = safetyClock(f, nowMs);
    return (
      <SafetyState mode={m} now={now} openRows={f.openRows} wallet={wallet} busy={held.choice !== null} choosing={choosing} onChoose={() => setChoosing(true)} onAction={open} />
    );
  })();

  return (
    <section className="home-section" aria-labelledby="vault-safety" data-testid="vault-safety">
      <h2 id="vault-safety">{text('safety.cardTitle')}</h2>
      {body}
      {choosing && held.choice === null && f && m && m !== 'absent' && !m.enabled && (
        <TurnOnForm bounds={f.bounds} onCancel={() => setChoosing(false)} onChosen={(d) => open('enable', d)} />
      )}
      {held.choice !== null && <SafetyActionFlow own={own} chain={chain} choice={held.choice} onClose={close} />}
      <OwnStamp reads={[facts]} />
      <p className="tier-b" data-testid="vault-safety-more">
        {text('safety.cardMore')}
      </p>
      <WhyLink summaryKey="safety.whySummary" detailKey="safety.why" />
      {f && m && m !== 'absent' && (m.enabled || (f.openRows ?? 0) > 0) && (
        <div data-testid="vault-safety-queue">
          <h3>{text('safety.queueTitle')}</h3>
          <PayoutQueue own={own} chain={chain} />
        </div>
      )}
    </section>
  );
}

interface StateProps {
  mode: SafetyMode;
  now: number | null;
  openRows: number | null;
  wallet: `0x${string}`;
  busy: boolean;
  choosing: boolean;
  onChoose: () => void;
  onAction: (a: SafetyAction) => void;
}

/** What the account's mode is, in words, and the actions it allows now. */
function SafetyState({ mode: m, now, openRows, wallet, busy, choosing, onChoose, onAction }: StateProps) {
  const { text, format } = useCopy();
  if (!m.enabled) {
    return (
      <>
        <p className="tier-a" data-testid="vault-safety-state" data-state="off">
          {text('safety.stateOff')}
        </p>
        <p className="tier-b">{text('safety.offLead')}</p>
        {!busy && !choosing && (
          <button type="button" className="btn btn-primary" onClick={onChoose} data-testid="vault-safety-turn-on">
            {text('safety.turnOn')}
          </button>
        )}
      </>
    );
  }
  const pending = pendingChanges(m);
  const due = now === null ? [] : dueChanges(m, now);
  const lockedBy = m.lockedBy.toLowerCase() === wallet.toLowerCase() ? text('safety.byYou') : shortAddress(m.lockedBy);
  return (
    <>
      <p className="tier-a" data-testid="vault-safety-state" data-state={m.locked ? 'locked' : 'on'}>
        {m.locked ? format('safety.stateLocked', { at: formatUtc(m.lockedAt), by: lockedBy }) : format('safety.stateOn', { delay: formatSpan(m.delaySeconds) })}
      </p>
      <dl className="facts">
        <dt>{text('safety.factDelay')}</dt>
        <dd data-testid="vault-safety-delay">{formatSpan(m.delaySeconds)}</dd>
        <dt>{text('safety.factCosign')}</dt>
        <dd>{text(m.requireCosign ? 'safety.cosignOn' : 'safety.cosignOff')}</dd>
        <dt>{text('safety.factNfts')}</dt>
        <dd>{text(m.protectNfts ? 'safety.nftsOn' : 'safety.nftsOff')}</dd>
        <dt>{text('safety.factQueued')}</dt>
        <dd data-testid="vault-safety-queued">{openRows === null ? text('safety.queuedUnread') : format('safety.payoutCount', { count: String(openRows) })}</dd>
      </dl>
      {pending.length > 0 && (
        <ul className="rows" data-testid="vault-safety-pending">
          {pending.map((p) => (
            <li key={p.change} data-testid={`vault-safety-pending-${p.change}`}>
              {format(now !== null && now >= p.at ? 'safety.pendingDue' : 'safety.pendingAt', { change: text(CHANGE_WORDS[p.change]), at: formatUtc(p.at) })}
            </li>
          ))}
        </ul>
      )}
      {!busy && (
        <div className="row-actions">
          {!m.locked && (
            <button type="button" className="btn btn-danger" onClick={() => onAction('lock')} data-testid="vault-safety-lock">
              {text('safety.lockNow')}
            </button>
          )}
          {m.locked && m.pendingUnlockAt === 0 && (
            <button type="button" className="btn" onClick={() => onAction('unlock')} data-testid="vault-safety-unlock">
              {text('safety.requestUnlock')}
            </button>
          )}
          {due.length > 0 && (
            <button type="button" className="btn btn-primary" onClick={() => onAction('finalize')} data-testid="vault-safety-finalize">
              {text('safety.applyDue')}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Turning the mode on: in Basic, the shortest delay the protocol allows
 *  and NFT protection off, both said; in Advanced, the reader chooses the
 *  delay in whole days inside the protocol's bounds, and NFT protection. */
function TurnOnForm({ bounds, onCancel, onChosen }: { bounds: { min: number; max: number } | null; onCancel: () => void; onChosen: (d: SafetyDraft) => void }) {
  const { text, format } = useCopy();
  const { isAdvanced } = useMode();
  const min = bounds?.min ?? null;
  const days = bounds === null ? [] : Array.from({ length: Math.floor(bounds.max / DAY) - Math.ceil(bounds.min / DAY) + 1 }, (_, i) => (Math.ceil(bounds.min / DAY) + i) * DAY);
  const [delay, setDelay] = useState<number | null>(min);
  const [nfts, setNfts] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (delay !== null) onChosen({ delaySeconds: isAdvanced ? delay : min!, protectNfts: isAdvanced ? nfts : false });
  };
  if (bounds === null)
    return (
      <Notice tone="warn" tier="A">
        {text('safety.boundsUnreadForm')}
      </Notice>
    );
  return (
    <form className="partial-form" onSubmit={submit} noValidate data-testid="vault-safety-form">
      {isAdvanced ? (
        <>
          <FormField label={text('safety.delayLabel')}>
            {({ id }) => (
              <select id={id} value={delay ?? undefined} onChange={(e) => setDelay(Number(e.target.value))} data-testid="vault-safety-delay-choice">
                {days.map((d) => (
                  <option key={d} value={d}>
                    {formatSpan(d)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <label className="choice">
            <input type="checkbox" checked={nfts} onChange={(e) => setNfts(e.target.checked)} data-testid="vault-safety-nfts" />
            <span>{text('safety.nftsLabel')}</span>
          </label>
          <p className="tier-b">{text('safety.nftsHint')}</p>
        </>
      ) : (
        <p className="tier-b" data-testid="vault-safety-basic-choice">
          {format('safety.basicChoice', { delay: formatSpan(bounds.min), max: formatSpan(bounds.max) })}
        </p>
      )}
      <div className="row-actions">
        <button type="submit" className="btn btn-primary" data-testid="vault-safety-review">
          {text('safety.reviewTurnOn')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {text('flow.cancel')}
        </button>
      </div>
    </form>
  );
}
