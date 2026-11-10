import { useState } from 'react';
import { isAddress, type Abi, type PublicClient } from 'viem';
import { ProtectedAccountFacetABI } from '@vaipakam/contracts/abis';
import { useMode } from '../../app/ModeContext';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCapabilities } from '../capability/CapabilityContext';
import type { Posture } from '../capability/types';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { useTokenMeta, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead, type OwnRead } from '../reads/useOwnRead';
import { useTxEntries, useTxStore } from '../tx/txStore';
import { reviewIdentity } from '../ui/ActionFlow';
import { FormField } from '../ui/FormField';
import { OwnStamp } from '../ui/OwnStamp';
import { formatSpan, formatUtc, shortAddress } from '../ui/format';
import { useNow } from '../ui/useNow';
import { holdsRole, queueClock, queueVerdict, readAccountQueue, releaseCancels, rowNeedsCosign, type AccountQueue, type QueueAction, type QueueRow } from './queue';
import { destinationWords } from './queueReview';
import type { QueueReview } from './queueReview';
import { payoutWords, QUEUE_KEY_PREFIX, queueActionKey, QueuePayoutAction, useQueueActionHeld } from './QueueAction';

type Hex = `0x${string}`;

const PROTECTED = ProtectedAccountFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';
const ACTIONS: readonly QueueAction[] = ['release', 'cosign', 'cancel'];

/** How the wallet relates to an account whose queue it is shown. */
type Role = 'own' | 'managed' | 'lookup';

async function readRetiredAccountOf(c: PublicClient, diamond: Hex, controller: Hex): Promise<Hex | null> {
  const a = (await c.readContract({ address: diamond, abi: PROTECTED, functionName: 'getRetiredAccountOf', args: [controller] })) as Hex;
  return a.toLowerCase() === ZERO ? null : a;
}

/**
 * Claims › Queue (LN-54, LN-55, LN-56): what waits in a protected account's
 * payout queue, in the order it comes due, each row under the request code
 * every alert prints, with what it pays, where, from when, and whether it is
 * co-signed; and the actions this wallet may take on it: release (anyone's,
 * once due), cancel (the account's manager or a secondary signer) and
 * co-sign (a signer, when the account requires it).
 *
 * The wallet's own account comes first, then an account it manages since a
 * replacement retired it; Advanced mode adds a lookup of any account, for a
 * secondary signer. Whether the keeper service releases due payouts here is
 * the capability service's answer, stated as such, and the pause posture is
 * said: a pause holds releases until its escape route opens, while cancelling
 * keeps working.
 */
export function PayoutQueue({ own, chain }: { own: OwnStateClient; chain: SupportedChain }) {
  const { text, format } = useCopy();
  const { isAdvanced } = useMode();
  const diamond = chain.diamondAddress;
  const wallet = own.account;
  const { caps } = useCapabilities();
  const keeper: Posture = caps?.keeper.find((k) => k.pass === 'protectedAccount')?.armed ?? 'unknown';
  const ownQueue = useOwnRead(['queue', diamond, wallet], (c) => readAccountQueue(c, diamond, wallet));
  const retired = useOwnRead(['queue', 'retiredOf', diamond, wallet], (c) => readRetiredAccountOf(c, diamond, wallet));
  const managed = retired.data ?? null;
  const managedQueue = useOwnRead(['queue', diamond, managed], (c) => readAccountQueue(c, diamond, managed!), { enabled: managed !== null });
  const [lookupText, setLookupText] = useState('');
  const lookup = isAdvanced && isAddress(lookupText.trim()) ? (lookupText.trim() as Hex) : null;
  const lookupQueue = useOwnRead(['queue', diamond, lookup], (c) => readAccountQueue(c, diamond, lookup!), { enabled: lookup !== null });

  const lookupShown = lookup !== null && lookup.toLowerCase() !== wallet.toLowerCase() && lookup.toLowerCase() !== managed?.toLowerCase();
  // Each read the section draws carries its age and any failed re-read in
  // the one stamp, the lookup included, and Refresh re-reads every one.
  const stamped = [ownQueue, retired, ...(managed !== null ? [managedQueue] : []), ...(lookupShown ? [lookupQueue] : [])];
  // A flow the store holds on an account no view is drawing with an answer
  // (a lookup since cleared, or a queue whose read failed) is drawn here, so
  // its progress, its Check again and its finish card stay reachable.
  const drawn = new Set(
    [ownQueue.data, managed !== null ? managedQueue.data : null, lookupShown ? lookupQueue.data : null]
      .filter((q): q is AccountQueue => q !== null)
      .map((q) => q.account.toLowerCase()),
  );
  const orphans = useHeldQueueFlows(reviewIdentity(own), (account) => !drawn.has(account.toLowerCase()));
  const orphanAccounts = [...new Set(orphans.map((h) => h.account.toLowerCase()))];

  const queues = [ownQueue.data, managedQueue.data, lookupQueue.data].filter((q): q is AccountQueue => q !== null);
  const assets = queues.flatMap((q) => (q.rows ?? []).flatMap((r) => (r.payout ? [r.payout.asset] : [])));
  const meta = useTokenMeta(assets).data;

  return (
    <section className="home-section" aria-labelledby="claims-queue">
      <h2 id="claims-queue">{text('queue.title')}</h2>
      <OwnStamp reads={stamped} />
      <AccountQueueView read={ownQueue} role="own" own={own} chain={chain} meta={meta} keeper={keeper} />
      {retired.state === 'failed' && retired.data === null && (
        <p className="tier-a" data-testid="queue-managed-unread">
          {text('queue.managedUnread')}
        </p>
      )}
      {managed !== null && <AccountQueueView read={managedQueue} role="managed" own={own} chain={chain} meta={meta} keeper={keeper} />}
      {isAdvanced && (
        <div className="queue-lookup">
          <FormField label={text('queue.lookupLabel')} hint={text('queue.lookupHint')} error={lookupText.trim() !== '' && lookup === null ? text('queue.lookupInvalid') : null}>
            {(ids) => (
              <input
                id={ids.id}
                aria-describedby={ids.describedBy}
                aria-invalid={ids.invalid}
                type="text"
                spellCheck={false}
                autoComplete="off"
                placeholder="0x…"
                value={lookupText}
                onChange={(e) => setLookupText(e.target.value)}
                data-testid="queue-lookup"
              />
            )}
          </FormField>
          {lookupShown && <AccountQueueView read={lookupQueue} role="lookup" own={own} chain={chain} meta={meta} keeper={keeper} />}
        </div>
      )}
      {orphanAccounts.map((a) => {
        const flows = orphans.filter((h) => h.account.toLowerCase() === a);
        return (
          <div key={a} className="queue-account" data-queue-account={a} data-role="held">
            <h3 className="row-head">{format('queue.heldHead', { address: shortAddress(flows[0]!.account) })}</h3>
            <ul className="rows">
              {flows.map((h) => (
                <HeldQueueCard key={`${h.action}:${h.id}`} id={h.id} action={h.action} account={h.account} code={h.code} own={own} chain={chain} meta={meta} />
              ))}
            </ul>
          </div>
        );
      })}
      <WhyLink summaryKey="queue.whySummary" detailKey="queue.why" />
    </section>
  );
}

function AccountQueueView({
  read,
  role,
  own,
  chain,
  meta,
  keeper,
}: {
  read: OwnRead<AccountQueue>;
  role: Role;
  own: OwnStateClient;
  chain: SupportedChain;
  meta: TokenMetaMap | null;
  keeper: Posture;
}) {
  const { text, format } = useCopy();
  const q = read.data;
  const listed = new Set((q?.rows ?? []).map((r) => r.id.toString()));
  const mine = q?.account.toLowerCase() ?? null;
  const held = useHeldQueueFlows(reviewIdentity(own), (account, id) => account.toLowerCase() === mine && !listed.has(id.toString()));
  if (q === null) {
    if (read.state === 'failed')
      return (
        <p className="tier-a" data-testid={`queue-failed-${role}`}>
          {format('queue.failed', { reason: read.error ?? '' })}
        </p>
      );
    return <p className="tier-b">{text('queue.reading')}</p>;
  }
  const off = q.mode !== null && !q.mode.enabled;
  const empty = q.rows !== null && q.rows.length === 0;
  return (
    <div className="queue-account" data-queue-account={q.account.toLowerCase()} data-role={role}>
      {role !== 'own' && <h3 className="row-head">{format(role === 'managed' ? 'queue.managedHead' : 'queue.lookupHead', { address: shortAddress(q.account) })}</h3>}
      {q.mode === null && <p className="tier-a">{text('queue.modeUnread')}</p>}
      {off && empty && held.length === 0 && (
        <p className="tier-b" data-testid={`queue-off-${role}`}>
          {text(role === 'own' ? 'queue.offOwn' : 'queue.offOther')}
        </p>
      )}
      {!off && q.mode !== null && (
        <>
          <p className="tier-b">{format(q.mode.requireCosign ? 'queue.factsCosign' : 'queue.facts', { delay: formatSpan(q.mode.delaySeconds) })}</p>
          <p className="tier-b" data-keeper={keeper}>
            {text(keeper === 'present' ? 'queue.keeperOn' : keeper === 'absent' ? 'queue.keeperOff' : 'queue.keeperUnknown')}
          </p>
        </>
      )}
      {q.paused === true && (
        <p className="tier-a" data-testid="queue-paused">
          {q.escapeOpen ? text('queue.pausedEscape') : q.escapeOpensAt ? format('queue.pausedUntil', { time: formatUtc(q.escapeOpensAt) }) : text('queue.pausedHeld')}
        </p>
      )}
      {q.rows === null && <p className="tier-a">{text('queue.rowsUnread')}</p>}
      {!off && empty && held.length === 0 && (
        <p className="tier-b home-empty" data-testid={`queue-empty-${role}`}>
          {text('queue.empty')}
        </p>
      )}
      {(q.rows?.length ?? 0) + held.length > 0 && (
        <ul className="rows" data-testid={`queue-rows-${role}`}>
          {(q.rows ?? []).map((r) => (
            <QueueRowCard key={r.id.toString()} q={q} row={r} own={own} chain={chain} meta={meta} />
          ))}
          {held.map((h) => (
            <HeldQueueCard key={`${h.action}:${h.id}`} id={h.id} action={h.action} account={q.account} code={h.code} own={own} chain={chain} meta={meta} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One queued payout: what it pays, where, from when, and the actions this
 *  wallet may take on it, each decided by its rule. */
function QueueRowCard({ q, row, own, chain, meta }: { q: AccountQueue; row: QueueRow; own: OwnStateClient; chain: SupportedChain; meta: TokenMetaMap | null }) {
  const copy = useCopy();
  const { text, format } = copy;
  const nowMs = useNow();
  const viewer = own.account;
  const flows = {
    release: useQueueActionHeld(row.id, 'release'),
    cosign: useQueueActionHeld(row.id, 'cosign'),
    cancel: useQueueActionHeld(row.id, 'cancel'),
  };
  const p = row.payout;
  const testId = row.id.toString();
  // An action already open on this row stays drawn whatever the latest row
  // read answered: its progress and Check again never hang on that read.
  const open = ACTIONS.find((a) => flows[a].held);
  const panel =
    open !== undefined ? <QueuePayoutAction account={q.account} id={row.id} action={open} chain={chain} own={own} meta={meta} onClose={() => flows[open].setOpen(null)} /> : null;
  if (p === null) {
    return (
      <li className="card" data-queue-row={testId}>
        <p className="row-head">{row.code ?? format('queue.rowNumber', { id: testId })}</p>
        <p className="tier-a">{text('queue.rowUnread')}</p>
        {panel}
      </li>
    );
  }
  const nowSec = queueClock(q, nowMs);
  const what = payoutWords(p, meta, format);
  const verdicts = Object.fromEntries(ACTIONS.map((a) => [a, queueVerdict(a, q, row, viewer, nowSec, copy)])) as Record<QueueAction, ReturnType<typeof queueVerdict>>;
  const cancels = releaseCancels(q, row);
  const release = verdicts.release;
  return (
    <li className="card queue-row" data-queue-row={testId}>
      <p className="row-head">
        <span className="request-code" aria-label={format('queue.codeLabel', { code: row.code ?? '' })} data-testid={`queue-code-${testId}`}>
          {row.code ?? format('queue.rowNumber', { id: testId })}
        </span>
      </p>
      <dl className="facts">
        <dt className="tier-b">{text('queue.rowPayout')}</dt>
        <dd>{what(p.amount, false)}</dd>
        <dt className="tier-b">{text('queue.rowDestination')}</dt>
        <dd>{destinationWords(q, p.recipient, viewer, copy)}</dd>
        <dt className="tier-b">{text('queue.rowDue')}</dt>
        <dd>{nowSec !== null && nowSec >= p.releaseAt ? text('queue.dueNow') : formatUtc(p.releaseAt)}</dd>
        {q.mode !== null && rowNeedsCosign(p, q.mode) && (
          <>
            <dt className="tier-b">{text('queue.rowCosign')}</dt>
            <dd>{text(p.cosigned ? 'queue.cosignGiven' : 'queue.cosignMissing')}</dd>
          </>
        )}
      </dl>
      {cancels === true && <p className="tier-a">{text('queue.notAllowedNote')}</p>}
      {panel ?? (
        <>
          <div className="form-actions">
            {ACTIONS.filter((a) => verdicts[a].state === 'open' && holdsRole(a, q, viewer)).map((a) => (
              <button key={a} type="button" className={a === 'release' ? 'btn btn-primary' : 'btn'} onClick={() => flows[a].setOpen(true)} data-testid={`queue-${a}-${testId}`}>
                {text(a === 'release' ? (cancels ? 'queue.actionReleaseCancels' : 'queue.actionRelease') : a === 'cancel' ? 'queue.actionCancel' : 'queue.actionCosign')}
              </button>
            ))}
          </div>
          {release.state !== 'open' && (
            <p className={release.state === 'unknown' ? 'tier-a' : 'tier-b'} data-code={release.refusals[0]?.code}>
              {release.state === 'closed' && release.refusals[0]?.code === 'PayoutNotDue'
                ? format('queue.releasableFrom', { time: formatUtc(p.releaseAt) })
                : release.refusals[0]?.reason}
            </p>
          )}
        </>
      )}
    </li>
  );
}

/** The action flows the store holds for this wallet that `pick` selects,
 *  by account and row: each one's account, row and action, from the review
 *  it stored. Read from the store alone, so a flow outlives the view that
 *  started it (a row the action removed, a lookup since cleared, a queue
 *  whose read failed). */
function useHeldQueueFlows(identity: string | null, pick: (account: Hex, id: bigint) => boolean): { account: Hex; id: bigint; action: QueueAction; code: string | null }[] {
  const store = useTxStore();
  const entries = useTxEntries();
  if (identity === null) return [];
  return entries.flatMap(([key]) => {
    if (!key.startsWith(QUEUE_KEY_PREFIX)) return [];
    const review = store.value<QueueReview>(`${key}:review`);
    if (!review || review.identity !== identity || queueActionKey(review.id, review.action) !== key) return [];
    if (!pick(review.account, review.id)) return [];
    return [{ account: review.account, id: review.id, action: review.action, code: review.row.code }];
  });
}

/** A row the queue no longer lists, drawn while its flow is held so the
 *  progress and the finish card stay reachable until the reader closes them. */
function HeldQueueCard({
  id,
  action,
  account,
  code,
  own,
  chain,
  meta,
}: {
  id: bigint;
  action: QueueAction;
  account: Hex;
  code: string | null;
  own: OwnStateClient;
  chain: SupportedChain;
  meta: TokenMetaMap | null;
}) {
  const { format } = useCopy();
  const flow = useQueueActionHeld(id, action);
  if (!flow.held) return null;
  return (
    <li className="card queue-row" data-queue-row={id.toString()}>
      <p className="row-head">
        <span className="request-code">{code ?? format('queue.rowNumber', { id: id.toString() })}</span>
      </p>
      <QueuePayoutAction account={account} id={id} action={action} chain={chain} own={own} meta={meta} onClose={() => flow.setOpen(null)} />
    </li>
  );
}
