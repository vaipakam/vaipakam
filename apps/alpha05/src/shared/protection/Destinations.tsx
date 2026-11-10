/**
 * ACC-41 / #3415 — Payout destinations on the Protection page: the
 * addresses besides the wallet that a protected payout may go to, each in
 * full with its saved name and the payouts queued to it; the requests still
 * waiting, with when each becomes usable or lapses; and a way to add one,
 * chosen only from the reader's saved addresses. Each change opens its own
 * review (`DestinationAction.tsx`).
 */
import { useState } from 'react';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import type { AddressBook, SavedAddress } from '../address/book';
import { FullAddress } from '../address/AddressEntry';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import type { OwnRead } from '../reads/useOwnRead';
import { formatUtc } from '../ui/format';
import { useNow } from '../ui/useNow';
import { Notice } from '../ui/Notice';
import { DestinationActionFlow, useDestinationHeld, type DestinationChoice } from './DestinationAction';
import { destinationClock, MAX_DESTINATIONS, pendingState, type DestinationFacts } from './destinations';

type Hex = `0x${string}`;

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

interface Props {
  chain: SupportedChain;
  own: OwnStateClient;
  facts: OwnRead<DestinationFacts>;
  book: AddressBook;
}

export function DestinationsSection({ chain, own, facts, book }: Props) {
  const { text, format } = useCopy();
  const held = useDestinationHeld();
  const [pick, setPick] = useState('');
  const nowMs = useNow();
  const f = facts.data;
  const savedFor = (a: Hex): SavedAddress | null => book.entries.find((e) => same(e.address, a)) ?? null;
  const open = (c: DestinationChoice) => held.open(c);

  let body;
  if (held.choice !== null) {
    body = (
      <DestinationActionFlow
        chain={chain}
        own={own}
        choice={held.choice}
        saved={savedFor(held.choice.destination)}
        onClose={() => {
          held.open(null);
          facts.refetch();
        }}
      />
    );
  } else if (f === null) {
    body =
      facts.state === 'failed' ? (
        <p className="tier-a" data-testid="destinations-failed">
          {format('dest.failed', { reason: facts.error ?? '' })}
        </p>
      ) : (
        <p className="tier-b">{text('dest.reading')}</p>
      );
  } else if (f.mode === 'absent') {
    body = <p className="tier-a">{text('safety.unavailable')}</p>;
  } else if (f.mode !== null && !f.mode.enabled) {
    body = (
      <p className="tier-b" data-testid="destinations-mode-off">
        {text('dest.modeOffNote')}
      </p>
    );
  } else {
    const m = f.mode;
    const now = destinationClock(f, nowMs);
    const label = (a: Hex) => savedFor(a)?.label ?? null;
    const pending = f.pending ?? [];
    const taken = new Set([...(f.destinations ?? []), ...pending.filter((p) => m === null || now === null || pendingState(p, m.delaySeconds, now) !== 'expired').map((p) => p.destination)].map((a) => a.toLowerCase()));
    const choices = book.entries.filter((e) => !taken.has(e.address.toLowerCase()) && !same(e.address, own.account));
    const chosen = choices.find((e) => e.address.toLowerCase() === pick.toLowerCase()) ?? null;
    body = (
      <>
        {f.destinations === null ? (
          <p className="tier-a">{format('dest.failed', { reason: text('receipt.unknown') })}</p>
        ) : f.destinations.length === 0 ? (
          <p className="tier-b" data-testid="destinations-none">
            {text('dest.none')}
          </p>
        ) : (
          <>
            <p className="tier-b">{format('dest.count', { count: String(f.destinations.length), max: String(MAX_DESTINATIONS) })}</p>
            <ul>
              {f.destinations.map((d) => (
                <li key={d} data-testid="destination-row" data-address={d.toLowerCase()}>
                  <p className="row-head">
                    {label(d) ?? text('dest.unlabelled')} · <span className="badge">{text('dest.active')}</span>
                  </p>
                  <FullAddress address={d} />
                  {f.queuedTo !== null && (f.queuedTo[d.toLowerCase()] ?? 0) > 0 && (
                    <p className="tier-b">{format('dest.queued', { count: String(f.queuedTo[d.toLowerCase()]) })}</p>
                  )}
                  <p className="actions">
                    <button type="button" className="btn" onClick={() => open({ action: 'remove', destination: d })} data-testid="destination-remove">
                      {text('dest.remove')}
                    </button>
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
        {pending.length > 0 && (
          <>
            <h3>{text('dest.waitingTitle')}</h3>
            <ul>
              {pending.map((p) => {
                const s = m === null || now === null ? null : pendingState(p, m.delaySeconds, now);
                return (
                  <li key={p.destination} data-testid="destination-pending" data-address={p.destination.toLowerCase()} data-state={s ?? 'unknown'}>
                    <p className="row-head">{label(p.destination) ?? text('dest.unlabelled')}</p>
                    <FullAddress address={p.destination} />
                    {s === 'waiting' && <p className="tier-b">{format('dest.waitsUntil', { at: formatUtc(p.maturesAt) })}</p>}
                    {s === 'ready' && m !== null && <p className="tier-b">{format('dest.readyUntil', { at: formatUtc(p.maturesAt + m.delaySeconds) })}</p>}
                    {s === 'expired' && m !== null && <p className="tier-b">{format('dest.lapsed', { at: formatUtc(p.maturesAt + m.delaySeconds) })}</p>}
                    <p className="actions">
                      {s === 'ready' && (
                        <button type="button" className="btn btn-primary" onClick={() => open({ action: 'apply', destination: p.destination })} data-testid="destination-apply">
                          {text('dest.apply')}
                        </button>
                      )}
                      {s === 'expired' && savedFor(p.destination) !== null && (
                        <button type="button" className="btn" onClick={() => open({ action: 'add', destination: p.destination })} data-testid="destination-ask-again">
                          {text('dest.askAgain')}
                        </button>
                      )}
                      {/* A lapsed request still holds one of the waiting places until it is cancelled. */}
                      <button type="button" className="btn" onClick={() => open({ action: 'cancel', destination: p.destination })} data-testid="destination-cancel">
                        {text('dest.cancel')}
                      </button>
                    </p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <h3>{text('dest.add')}</h3>
        {book.entries.length === 0 ? (
          <p className="tier-b">{text('dest.noneSaved')}</p>
        ) : choices.length === 0 ? (
          <p className="tier-b">{text('dest.allUsed')}</p>
        ) : (
          <div className="approval-add">
            <label htmlFor="destination-pick">{text('dest.addPick')}</label>
            <select id="destination-pick" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="destination-pick">
              <option value="">—</option>
              {choices.map((e) => (
                <option key={e.address} value={e.address}>
                  {e.label} · {e.address}
                </option>
              ))}
            </select>
            {chosen !== null && <FullAddress address={chosen.address} />}
            {chosen?.kind === 'exchange' && (
              <Notice tone="warn" tier="A">
                {format('dest.addExchange', { exchange: chosen.exchange ?? '' })}
              </Notice>
            )}
            <p className="actions">
              <button type="button" className="btn btn-primary" disabled={chosen === null} onClick={() => chosen && open({ action: 'add', destination: chosen.address })} data-testid="destination-add">
                {text('dest.add')}
              </button>
            </p>
          </div>
        )}
      </>
    );
  }
  return (
    <section className="home-section destinations" aria-labelledby="dest-title" data-testid="destinations">
      <h2 id="dest-title">{text('dest.title')}</h2>
      <p className="tier-b">{text('dest.lead')}</p>
      {body}
      <WhyLink summaryKey="dest.whySummary" detailKey="dest.why" />
    </section>
  );
}
