/**
 * ACC-41 / #3415 — Secondary signers on the Protection page: the wallets
 * that can cancel a waiting change, lock the account, cancel or co-sign a
 * queued payout and remove a destination, each in full with its saved name
 * and any removal waiting; the wallets asked to join, with the link each
 * opens to accept and when it can be made active; the co-sign switch; and
 * a way to ask a wallet, chosen only from the reader's saved wallets that
 * proved control by signing. Each change opens its own review
 * (`SignerAction.tsx`).
 */
import { useState } from 'react';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { copyText } from '../address/AddressBook';
import type { AddressBook, SavedAddress } from '../address/book';
import { FullAddress } from '../address/AddressEntry';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import type { OwnRead } from '../reads/useOwnRead';
import { formatUtc } from '../ui/format';
import { useNow } from '../ui/useNow';
import { SIGNER_KEY, SignerActionFlow, useSignerHeld, type SignerChoice } from './SignerAction';
import { MAX_SIGNERS, nomineeState, signerClock, type PendingSigner, type SignerFacts } from './signers';

type Hex = `0x${string}`;

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/** The link the asked wallet opens to accept the role. */
export function acceptLink(account: Hex, chainId: number): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/protection?signer=${account}&chain=${chainId}`;
}

interface Props {
  chain: SupportedChain;
  own: OwnStateClient;
  facts: OwnRead<SignerFacts>;
  book: AddressBook;
}

export function SignersSection({ chain, own, facts, book }: Props) {
  const { text, format } = useCopy();
  const held = useSignerHeld(SIGNER_KEY);
  const [pick, setPick] = useState('');
  const nowMs = useNow();
  const f = facts.data;
  const savedFor = (a: Hex): SavedAddress | null => book.entries.find((e) => same(e.address, a)) ?? null;
  const open = (c: SignerChoice) => held.open(c);

  let body;
  if (held.choice !== null) {
    body = (
      <SignerActionFlow
        chain={chain}
        own={own}
        account={own.account}
        storeKey={SIGNER_KEY}
        choice={held.choice}
        saved={savedFor(held.choice.signer)}
        onClose={() => {
          held.open(null);
          facts.refetch();
        }}
      />
    );
  } else if (f === null) {
    body =
      facts.state === 'failed' ? (
        <p className="tier-a" data-testid="signers-failed">
          {format('signer.failed', { reason: facts.error ?? '' })}
        </p>
      ) : (
        <p className="tier-b">{text('signer.reading')}</p>
      );
  } else if (f.mode === 'absent') {
    body = <p className="tier-a">{text('safety.unavailable')}</p>;
  } else if (f.mode !== null && !f.mode.enabled) {
    body = (
      <p className="tier-b" data-testid="signers-mode-off">
        {text('signer.modeOffNote')}
      </p>
    );
  } else {
    const m = f.mode;
    const now = signerClock(f, nowMs);
    const label = (a: Hex) => savedFor(a)?.label ?? null;
    const pending = f.pending ?? [];
    const taken = new Set([...(f.signers ?? []).map((s) => s.signer), ...pending.map((p) => p.signer)].map((a) => a.toLowerCase()));
    // A signer must be able to accept from its own key, so only a saved
    // wallet that proved control by signing can be asked.
    const choices = book.entries.filter((e) => e.kind === 'wallet' && !taken.has(e.address.toLowerCase()) && !same(e.address, own.account));
    const chosen = choices.find((e) => e.address.toLowerCase() === pick.toLowerCase()) ?? null;
    const signerCount = f.signers?.length ?? null;
    body = (
      <>
        {m === null && (
          <p className="tier-a" data-testid="signers-mode-unread">
            {text('signer.pageModeUnread')}
          </p>
        )}
        {m !== null && (
          <div data-testid="signers-cosign" data-on={String(m.requireCosign)}>
            <p className="row-head">{text(m.requireCosign ? 'signer.cosignIsOn' : 'signer.cosignIsOff')}</p>
            {m.requireCosign && m.pendingCosignOffAt !== 0 && (
              <p className="tier-b">{format('signer.cosignOffPending', { at: formatUtc(m.pendingCosignOffAt) })}</p>
            )}
            <p className="actions">
              {(!m.requireCosign || m.pendingCosignOffAt !== 0) && signerCount !== null && signerCount > 0 && (
                <button type="button" className="btn" onClick={() => open({ action: 'cosignOn', signer: own.account })} data-testid="signers-cosign-on">
                  {text(m.requireCosign ? 'signer.cosignKeep' : 'signer.cosignTurnOn')}
                </button>
              )}
              {m.requireCosign && m.pendingCosignOffAt === 0 && (
                <button type="button" className="btn" onClick={() => open({ action: 'cosignOff', signer: own.account })} data-testid="signers-cosign-off">
                  {text('signer.cosignTurnOff')}
                </button>
              )}
            </p>
            {!m.requireCosign && signerCount === 0 && <p className="tier-b">{text('signer.cosignNeedsSignerNote')}</p>}
          </div>
        )}
        {f.signers === null ? (
          <p className="tier-a" data-testid="signers-unread">
            {text('signer.listUnreadPage')}
          </p>
        ) : f.signers.length === 0 ? (
          <p className="tier-b" data-testid="signers-none">
            {text('signer.none')}
          </p>
        ) : (
          <>
            <p className="tier-b">{format('signer.count', { count: String(f.signers.length), max: String(MAX_SIGNERS) })}</p>
            <ul>
              {f.signers.map((s) => {
                const removing = s.removeAt !== 0;
                const due = removing && now !== null && now >= s.removeAt;
                return (
                  <li key={s.signer} data-testid="signer-row" data-address={s.signer.toLowerCase()} data-removing={String(removing)}>
                    <p className="row-head">
                      {label(s.signer) ?? text('dest.unlabelled')} · <span className="badge">{text('dest.active')}</span>
                    </p>
                    <FullAddress address={s.signer} />
                    {removing && <p className="tier-b">{format(due ? 'signer.removeReady' : 'signer.removeWaits', { at: formatUtc(s.removeAt) })}</p>}
                    <p className="actions">
                      {!removing && (
                        <button type="button" className="btn" onClick={() => open({ action: 'remove', signer: s.signer })} data-testid="signer-remove">
                          {text('signer.remove')}
                        </button>
                      )}
                      {due && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => open({ action: 'applyRemove', signer: s.signer })}
                          data-testid="signer-apply-remove"
                        >
                          {text('signer.applyRemove')}
                        </button>
                      )}
                      {removing && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => open({ action: 'cancelRemove', signer: s.signer })}
                          data-testid="signer-cancel-remove"
                        >
                          {text('signer.cancelRemove')}
                        </button>
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {f.pending === null && (
          <>
            <h3>{text('signer.waitingTitle')}</h3>
            <p className="tier-a" data-testid="signers-pending-unread">
              {text('signer.pendingUnread')}
            </p>
          </>
        )}
        {pending.length > 0 && (
          <>
            <h3>{text('signer.waitingTitle')}</h3>
            <ul>
              {pending.map((p) => (
                <NomineeRow
                  key={p.signer}
                  p={p}
                  label={label(p.signer)}
                  state={m === null || now === null ? null : nomineeState(p, m.delaySeconds, now)}
                  windowEnd={m === null ? null : p.maturesAt + m.delaySeconds}
                  link={acceptLink(own.account, chain.chainId)}
                  open={open}
                />
              ))}
            </ul>
          </>
        )}
        <h3>{text('signer.add')}</h3>
        {choices.length === 0 ? (
          <p className="tier-b">{text(book.entries.some((e) => e.kind === 'wallet') ? 'signer.allUsed' : 'signer.noneSaved')}</p>
        ) : (
          <div className="approval-add">
            <label htmlFor="signer-pick">{text('signer.addPick')}</label>
            <select id="signer-pick" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="signer-pick">
              <option value="">—</option>
              {choices.map((e) => (
                <option key={e.address} value={e.address}>
                  {e.label} · {e.address}
                </option>
              ))}
            </select>
            {chosen !== null && <FullAddress address={chosen.address} />}
            <p className="actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={chosen === null}
                onClick={() => chosen && open({ action: 'add', signer: chosen.address })}
                data-testid="signer-add"
              >
                {text('signer.add')}
              </button>
            </p>
          </div>
        )}
      </>
    );
  }
  return (
    <section className="home-section signers" aria-labelledby="signer-title" data-testid="signers">
      <h2 id="signer-title">{text('signer.title')}</h2>
      <p className="tier-b">{text('signer.lead')}</p>
      {body}
      <WhyLink summaryKey="signer.whySummary" detailKey="signer.why" />
    </section>
  );
}

function NomineeRow({
  p,
  label,
  state,
  windowEnd,
  link,
  open,
}: {
  p: PendingSigner;
  label: string | null;
  state: 'waiting' | 'ready' | 'expired' | null;
  windowEnd: number | null;
  link: string;
  open: (c: SignerChoice) => void;
}) {
  const { text, format } = useCopy();
  const [copied, setCopied] = useState(false);
  return (
    <li data-testid="signer-pending" data-address={p.signer.toLowerCase()} data-state={state ?? 'unknown'} data-accepted={String(p.accepted)}>
      <p className="row-head">{label ?? text('dest.unlabelled')}</p>
      <FullAddress address={p.signer} />
      <p className="tier-b">{text(p.accepted ? 'signer.hasAccepted' : 'signer.notAcceptedYet')}</p>
      {state === 'waiting' && <p className="tier-b">{format('signer.waitsUntil', { at: formatUtc(p.maturesAt) })}</p>}
      {state === 'ready' && windowEnd !== null && (
        <p className="tier-b">{format(p.accepted ? 'signer.readyUntil' : 'signer.readyNeedsAccept', { at: formatUtc(windowEnd) })}</p>
      )}
      {state === 'expired' && windowEnd !== null && <p className="tier-b">{format('signer.lapsed', { at: formatUtc(windowEnd) })}</p>}
      {state === null && <p className="tier-a">{text('dest.timingUnknown')}</p>}
      {!p.accepted && state !== 'expired' && (
        <>
          <p className="tier-b">{text('signer.sendLink')}</p>
          <textarea
            readOnly
            value={link}
            rows={2}
            aria-label={text('book.copyLink')}
            data-testid="signer-accept-link"
            onFocus={(e) => e.currentTarget.select()}
          />
          <p className="actions">
            <button type="button" className="btn" onClick={() => void copyText(link).then(setCopied)}>
              {text(copied ? 'book.copied' : 'book.copyLink')}
            </button>
          </p>
        </>
      )}
      <p className="actions">
        {state === 'ready' && p.accepted && (
          <button type="button" className="btn btn-primary" onClick={() => open({ action: 'applyAdd', signer: p.signer })} data-testid="signer-apply">
            {text('signer.apply')}
          </button>
        )}
        <button type="button" className="btn" onClick={() => open({ action: 'cancelAdd', signer: p.signer })} data-testid="signer-cancel">
          {text('signer.cancel')}
        </button>
      </p>
    </li>
  );
}
