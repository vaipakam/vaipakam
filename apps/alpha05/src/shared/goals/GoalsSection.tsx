import { useState, type FormEvent } from 'react';
import { getSupportedChain } from '../../chain/chains';
import { useOwnStateClient } from '../../chain/ownRail';
import { readMyAutoLend, type MyAutoLendRead } from '../autolend/myAutoLend';
import { AGENT, type AgentClient } from '../alerts/agentClient';
import { useSignedRequest, type SignedRoute, type SignedRun } from '../alerts/useSignedRequest';
import { useCopy } from '../copy/useCopy';
import { parseAmount } from '../post/postModel';
import { tokenAmount, useTokenMeta, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead, type OwnRead } from '../reads/useOwnRead';

import type { LiveLoans } from '../positions/reads';
import { formatUtcDate, shortAddress } from '../ui/format';
import {
  formAsset,
  goalBody,
  goalFromForm,
  goalLoans,
  goalMessage,
  goalPath,
  loansProgress,
  readGoalAnswer,
  slotKey,
  slotProgress,
  type FormAttach,
  type Goal,
  type GoalAction,
  type GoalAnswer,
  type GoalFormProblem,
  type GoalProgress,
  type SlotRef,
} from './goals';

type Hex = `0x${string}`;

const ROUTE: SignedRoute<GoalAction, GoalAnswer> = { message: goalMessage, path: goalPath, body: goalBody, read: readGoalAnswer };

/** The end of a `YYYY-MM-DD` day in UTC, in unix seconds, or null. */
/** The clock, read when the form is sent (outside render). */
const nowSec = () => Math.floor(Date.now() / 1000);

export function endOfUtcDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) + 86_399 : null;
}

/**
 * #3771 — goals on Positions (FeaturesOverExistingPartsDesign.md §4). A goal
 * is a note kept by the alert service for the wallet: it locks nothing and
 * changes nothing on chain, and the section says so before anything else.
 * The list is private, so it is shown only after the wallet signs to see
 * it; progress is counted from the live positions this page already read.
 */
export function GoalsSection({ read, meta, chainId, wallet, client = AGENT }: { read: OwnRead<LiveLoans>; meta: TokenMetaMap | null; chainId: number; wallet: Hex; client?: AgentClient }) {
  const { text, format } = useCopy();
  const { run, busy, send, off } = useSignedRequest(ROUTE, chainId, wallet, client);
  const [listed, setListed] = useState<{ goals: Goal[]; max: number | null } | null>(null);
  const live = read.data;
  const own = useOwnStateClient();
  const chain = own ? getSupportedChain(own.chainId) : null;
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  // The same read (and cache entry) as the Auto-lend section below.
  const slotRead = useOwnRead(['autolend', 'mine'], (c) => readMyAutoLend(c, diamond, own!.account), { enabled: chain !== null });
  const slots = slotRead.data;
  const slotMeta = useTokenMeta((slots?.rows ?? []).flatMap((r) => [r.intent.lendingAsset, r.intent.collateralAsset])).data;
  const allMeta: TokenMetaMap | null = meta || slotMeta ? { ...(slotMeta ?? {}), ...(meta ?? {}) } : null;

  const list = async () => {
    const a = await send({ kind: 'list' });
    if (a?.ok && a.kind === 'list') setListed({ goals: a.goals, max: a.maxGoals });
  };
  const remove = async (id: number) => {
    const a = await send({ kind: 'delete', goalId: id });
    if (a?.ok && listed) setListed({ ...listed, goals: listed.goals.filter((g) => g.id !== id) });
  };
  const save = async (action: GoalAction) => {
    const a = await send(action);
    if (a?.ok && a.kind === 'save') await list();
  };

  const here = listed?.goals.filter((g) => g.chainId === chainId) ?? [];
  const elsewhere = (listed?.goals.length ?? 0) - here.length;

  return (
    <section className="home-section" aria-labelledby="positions-goals" data-testid="positions-goals">
      <h2 id="positions-goals">{text('goals.title')}</h2>
      <p className="tier-a">{text('goals.lead')}</p>
      <p className="tier-a" data-testid="goals-no-lock">
        {text('goals.noLock')}
      </p>
      {off ? (
        <p className="tier-a" data-testid="goals-off">
          {text('goals.notSetUp')}
        </p>
      ) : (
        <>
          <p className="tier-b">{text('goals.private')}</p>
          <div className="position-action-row">
            <button type="button" className="btn" disabled={busy} onClick={() => void list()} data-testid="goals-show">
              {text(listed === null ? 'goals.show' : 'goals.showAgain')}
            </button>
          </div>
          <RunLine run={run} />
          {listed !== null && (
            <div data-testid="goals-list">
              <p className="tier-b">
                {here.length === 0
                  ? text('goals.none')
                  : listed.max === null
                    ? format('goals.count', { count: String(here.length) })
                    : format('goals.countMax', { count: String(listed.goals.length), max: String(listed.max) })}
              </p>
              {elsewhere > 0 && <p className="tier-b">{format('goals.otherNetwork', { count: String(elsewhere) })}</p>}
              <ul className="plain-list">
                {here.map((g) => (
                  <GoalRow key={g.id} goal={g} live={live} slots={slots} meta={allMeta} busy={busy} onDelete={() => void remove(g.id)} />
                ))}
              </ul>
            </div>
          )}
          <NewGoal live={live} slots={slots} meta={allMeta} busy={busy} onSave={(a) => void save(a)} />
        </>
      )}
    </section>
  );
}

function progressOf(goal: Goal, live: LiveLoans | null, slots: MyAutoLendRead | null): GoalProgress | null {
  if (goal.attachTo.kind === 'loans') return live === null ? null : loansProgress(goal, live.rows, live.complete);
  return slots === null ? null : slotProgress(goal, slots.rows, BigInt(slots.rows.length) >= slots.total);
}

function GoalRow({ goal, live, slots, meta, busy, onDelete }: { goal: Goal; live: LiveLoans | null; slots: MyAutoLendRead | null; meta: TokenMetaMap | null; busy: boolean; onDelete: () => void }) {
  const { text, format } = useCopy();
  const p = progressOf(goal, live, slots);
  const amount = (v: bigint) => tokenAmount(v, goal.asset, meta, format);
  const a = goal.attachTo;
  return (
    <li data-testid="goal-row" data-goal={goal.id}>
      <p className="tier-b">
        <strong>{goal.name}</strong> — {format('goals.target', { amount: amount(BigInt(goal.targetAmount)), date: formatUtcDate(goal.targetDate) })}
      </p>
      <p className="tier-b">
        {a.kind === 'loans'
          ? format('goals.loans', { ids: a.loanIds.map((i) => `#${i}`).join(', ') })
          : format('goals.slotLine', { pair: pairName(a.lendingAsset, a.collateralAsset, meta), slot: String(a.slot + 1) })}
      </p>
      {p === null ? (
        <p className="tier-a">{text('goals.progressUnread')}</p>
      ) : p.kind === 'loans' ? (
        <>
          <p className="tier-a" data-testid="goal-progress">
            {p.complete ? format('goals.progress', { amount: amount(p.counted), loans: String(p.countedLoans) }) : format('goals.progressPartial', { amount: amount(p.counted) })}
          </p>
          {p.reached && <p className="tier-b">{text('goals.progressReached')}</p>}
          {p.notFound > 0 && <p className="tier-a">{format(p.complete ? 'goals.progressGone' : 'goals.progressGoneUnread', { count: String(p.notFound) })}</p>}
        </>
      ) : p.kind === 'slot' ? (
        <>
          <p className="tier-a" data-testid="goal-progress">
            {format('goals.progressSlot', { waiting: amount(p.waiting), lent: amount(p.lent) })}
          </p>
          {!p.active && <p className="tier-a">{text('goals.slotStopped')}</p>}
          {p.reached && <p className="tier-b">{text('goals.progressSlotReached')}</p>}
        </>
      ) : (
        <p className="tier-a" data-testid="goal-progress">
          {text(p.complete ? 'goals.slotMissing' : 'goals.slotMissingPartial')}
        </p>
      )}
      <button type="button" className="btn" disabled={busy} onClick={onDelete} data-testid="goal-delete">
        {text('goals.delete')}
      </button>
    </li>
  );
}

function pairName(lending: string, collateral: string, meta: TokenMetaMap | null): string {
  const sym = (a: string) => meta?.[a.toLowerCase()]?.symbol ?? shortAddress(a);
  return `${sym(lending)} / ${sym(collateral)}`;
}

const FORM_ERRORS: Record<GoalFormProblem, string> = {
  name: 'goals.errName',
  'no-loans': 'goals.errNoLoans',
  'no-slot': 'goals.errNoSlot',
  'mixed-tokens': 'goals.errMixed',
  amount: 'goals.errAmount',
  date: 'goals.errDate',
  past: 'goals.errPast',
};

function NewGoal({ live, slots, meta, busy, onSave }: { live: LiveLoans | null; slots: MyAutoLendRead | null; meta: TokenMetaMap | null; busy: boolean; onSave: (a: GoalAction) => void }) {
  const { text, format } = useCopy();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<'loans' | 'slot'>('loans');
  const [picked, setPicked] = useState<bigint[]>([]);
  const [slotPick, setSlotPick] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const loans = live === null ? [] : goalLoans(live.rows);
  const slotRefs: SlotRef[] = (slots?.rows ?? []).map((r) => ({ lendingAsset: r.intent.lendingAsset, collateralAsset: r.intent.collateralAsset, slot: r.intent.slot }));
  if (loans.length === 0 && slotRefs.length === 0) {
    return live === null && slots === null ? null : (
      <div data-testid="goal-new">
        <h3>{text('goals.newTitle')}</h3>
        <p className="tier-a">{text('goals.nothingToAttach')}</p>
      </div>
    );
  }
  const attach: FormAttach = kind === 'slot' ? { kind: 'slot', slot: slotRefs.find((r) => slotKey(r) === slotPick) ?? null } : { kind: 'loans', loanIds: picked };
  const asset = formAsset(attach, live?.rows ?? []);
  const decimals = asset === null ? null : (meta?.[asset.toLowerCase()]?.decimals ?? null);
  const toggle = (id: bigint) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (asset !== null && decimals === null) return setError('goals.errMeta');
    let target: bigint | null = null;
    if (decimals !== null) {
      const a = parseAmount(amount, decimals);
      if (!a.ok) return setError(a.error === 'decimals' ? 'goals.errDecimals' : 'goals.errAmount');
      target = a.value;
    }
    const built = goalFromForm({ name, target, date: endOfUtcDay(date), attach }, live?.rows ?? [], nowSec());
    if (!built.ok) return setError(FORM_ERRORS[built.problem]);
    setError(null);
    onSave({ kind: 'save', goalId: null, goal: built.goal });
  };

  return (
    <form onSubmit={submit} data-testid="goal-new">
      <h3>{text('goals.newTitle')}</h3>
      <fieldset>
        <legend>{text('goals.attachTo')}</legend>
        <label className="choice">
          <input type="radio" name="goal-attach" checked={kind === 'loans'} disabled={loans.length === 0} onChange={() => setKind('loans')} data-testid="goal-attach-loans" />
          {text('goals.attachLoans')}
        </label>
        <label className="choice">
          <input type="radio" name="goal-attach" checked={kind === 'slot'} disabled={slotRefs.length === 0} onChange={() => setKind('slot')} data-testid="goal-attach-slot" />
          {text('goals.attachSlot')}
        </label>
      </fieldset>
      {kind === 'loans' ? (
        loans.length === 0 ? (
          <p className="tier-a">{text('goals.noLoans')}</p>
        ) : (
          <fieldset>
            <legend>{text('goals.chooseLoans')}</legend>
            {loans.map((r) => (
              <label key={r.loan.id.toString()} className="choice">
                <input type="checkbox" checked={picked.includes(r.loan.id)} onChange={() => toggle(r.loan.id)} data-testid="goal-loan" />
                {format('goals.loanLine', { id: r.loan.id.toString(), amount: tokenAmount(r.loan.principal, r.loan.principalAsset, meta, format) })}
              </label>
            ))}
          </fieldset>
        )
      ) : slotRefs.length === 0 ? (
        <p className="tier-a">{text('goals.noSlots')}</p>
      ) : (
        <label>
          {text('goals.chooseSlot')}
          <select value={slotPick} onChange={(e) => setSlotPick(e.target.value)} data-testid="goal-slot">
            <option value="">{text('goals.chooseSlotNone')}</option>
            {slotRefs.map((r) => (
              <option key={slotKey(r)} value={slotKey(r)}>
                {format('goals.slotLine', { pair: pairName(r.lendingAsset, r.collateralAsset, meta), slot: String(r.slot + 1) })}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {text('goals.name')}
        <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="goal-name" />
      </label>
      <label>
        {text('goals.amount')}
        <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="goal-amount" />
      </label>
      <p className="tier-b">{text(kind === 'slot' ? 'goals.amountHintSlot' : 'goals.amountHint')}</p>
      <label>
        {text('goals.date')}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="goal-date" />
      </label>
      <p className="tier-b">{text('goals.dateHint')}</p>
      {error !== null && (
        <p className="tier-a" role="alert" data-testid="goal-error">
          {text(error as never)}
        </p>
      )}
      <button type="submit" className="btn" disabled={busy} data-testid="goal-save">
        {text('goals.save')}
      </button>
    </form>
  );
}

function RunLine({ run }: { run: SignedRun<GoalAnswer> }) {
  const { text, format } = useCopy();
  if (run.phase === 'idle') return null;
  if (run.phase === 'signing' || run.phase === 'sending') {
    return (
      <p className="tier-b" role="status" data-testid="goals-run">
        {text(run.phase === 'signing' ? 'goals.signing' : 'goals.sending')}
      </p>
    );
  }
  if (run.phase === 'declined') return <p className="tier-b" data-testid="goals-run">{text('goals.declined')}</p>;
  if (run.phase === 'unreachable') return <p className="tier-a" data-testid="goals-run">{format('goals.unreachable', { reason: run.message })}</p>;
  if (run.phase !== 'answered') return null;
  const a = run.answer;
  if (a.ok) {
    if (a.kind === 'list') return null;
    return (
      <p className="tier-b" data-testid="goals-run" data-outcome={a.kind}>
        {text(a.kind === 'save' ? 'goals.saved' : 'goals.deleted')}
      </p>
    );
  }
  const line = (() => {
    switch (a.problem) {
      case 'used':
        return text('goals.used');
      case 'refused':
        return text('goals.refused');
      case 'verify-down':
        return text('goals.verifyDown');
      case 'chain-not-served':
        return text('goals.chainNotServed');
      case 'not-found':
        return text('goals.notFound');
      case 'too-many-goals':
        return a.limit === null ? text('goals.tooManyUnstated') : format('goals.tooMany', { limit: String(a.limit) });
      case 'changes-spent':
        return a.limit === null ? text('goals.changesSpentUnstated') : format('goals.changesSpent', { limit: String(a.limit) });
      default:
        return format('goals.other', { status: String(a.status) });
    }
  })();
  return (
    <p className="tier-a" data-testid="goals-run" data-outcome={a.problem}>
      {line}
    </p>
  );
}
