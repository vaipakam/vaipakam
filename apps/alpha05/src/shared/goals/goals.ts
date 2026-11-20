/**
 * #3771 — goals (FeaturesOverExistingPartsDesign.md §4): a name, a target
 * amount of one token and a date, attached to loans the wallet lent. A goal
 * is the user's own note. It locks nothing and changes nothing on chain;
 * the alert service keeps it for the wallet, and every write and read is
 * signed by the wallet. Pure, so every outcome is tested.
 *
 * The messages come from `@vaipakam/lib/goals`, built from what
 * `parseGoalInput` returns, exactly as the service does, so the wallet
 * prompt and the text the service checks cannot differ.
 *
 * Progress is counted from the live positions the Positions page already
 * read: the principal still out in the attached loans whose lender side the
 * wallet holds now, in the goal's token. Interest and anything already
 * collected are not counted, and a loan that ended, was given away or could
 * not be read is counted apart, never as zero progress silently. A goal on
 * an Auto-lend slot counts the slot's money as the protocol lists it: what
 * waits to be lent plus what is lent now.
 */
import { buildDeleteGoalMessage, buildListGoalsMessage, buildSaveGoalMessage, parseGoalInput, type GoalInput } from '@vaipakam/lib/goals';
import type { MyAutoLend } from '../autolend/myAutoLend';
import { ASSET_ERC20, type LiveLoanRow } from '../positions/model';

type Hex = `0x${string}`;

export type GoalAction = { kind: 'save'; goalId: number | null; goal: GoalInput } | { kind: 'delete'; goalId: number } | { kind: 'list' };

/** The goal as the service stores it: checked, so it can be signed. */
export function checkedGoal(raw: GoalInput): GoalInput | null {
  const p = parseGoalInput(raw);
  return p.ok ? p.goal : null;
}

export function goalMessage(action: GoalAction, wallet: Hex, chainId: number, issuedAt: number): string {
  if (action.kind === 'list') return buildListGoalsMessage(wallet, chainId, issuedAt);
  if (action.kind === 'delete') return buildDeleteGoalMessage(wallet, chainId, action.goalId, issuedAt);
  return buildSaveGoalMessage(wallet, chainId, action.goalId, action.goal, issuedAt);
}

export function goalPath(action: GoalAction): string {
  return action.kind === 'save' ? '/goals/save' : action.kind === 'delete' ? '/goals/delete' : '/goals/list';
}

export function goalBody(action: GoalAction, wallet: Hex, chainId: number, issuedAt: number, signature: Hex): Record<string, unknown> {
  const signed = { wallet, chain_id: chainId, issuedAt, signature };
  if (action.kind === 'list') return signed;
  if (action.kind === 'delete') return { ...signed, goalId: action.goalId };
  return { ...signed, ...(action.goalId === null ? {} : { goalId: action.goalId }), goal: action.goal };
}

/** One goal as the service lists it. */
export interface Goal extends GoalInput {
  id: number;
  chainId: number;
  createdAt: number;
  updatedAt: number;
}

export type GoalProblem = 'used' | 'refused' | 'verify-down' | 'chain-not-served' | 'not-found' | 'too-many-goals' | 'changes-spent' | 'other';

export type GoalAnswer =
  | { ok: true; kind: 'save'; id: number }
  | { ok: true; kind: 'delete' }
  | { ok: true; kind: 'list'; goals: Goal[]; maxGoals: number | null }
  | { ok: false; problem: GoalProblem; status: number; limit: number | null };

const posInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;

/** A listed goal, read strictly: anything the service would not have stored
 *  is dropped from the list, and the answer then says the list is not whole. */
export function parseGoal(raw: unknown): Goal | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!posInt(r.id) || !posInt(r.chainId) || !posInt(r.createdAt) || !posInt(r.updatedAt)) return null;
  const g = parseGoalInput(r);
  if (!g.ok) return null;
  return { ...g.goal, id: r.id, chainId: r.chainId, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

export function readGoalAnswer(action: GoalAction, status: number, data: Record<string, unknown> | null): GoalAnswer {
  const error = typeof data?.error === 'string' ? data.error : null;
  const limit = posInt(data?.limit) ? (data.limit as number) : null;
  const fail = (problem: GoalProblem): GoalAnswer => ({ ok: false, problem, status, limit });
  if (status >= 200 && status < 300 && data) {
    if (action.kind === 'save' && data.ok === true && posInt(data.id)) return { ok: true, kind: 'save', id: data.id };
    if (action.kind === 'delete' && data.ok === true) return { ok: true, kind: 'delete' };
    if (action.kind === 'list' && Array.isArray(data.goals)) {
      const goals = data.goals.map(parseGoal);
      if (goals.some((g) => g === null)) return fail('other');
      const lim = data.limits as Record<string, unknown> | undefined;
      return { ok: true, kind: 'list', goals: goals as Goal[], maxGoals: posInt(lim?.maxPerWallet) ? (lim.maxPerWallet as number) : null };
    }
    return fail('other');
  }
  if (status === 409 && error === 'request-already-used') return fail('used');
  if (status === 503 && error === 'verification-unavailable') return fail('verify-down');
  if (status === 400 && error === 'chain-not-served') return fail('chain-not-served');
  if (status === 404 && error === 'goal-not-found') return fail('not-found');
  if (status === 409 && error === 'too-many-goals') return fail('too-many-goals');
  if (status === 429 && error === 'changes-spent') return fail('changes-spent');
  if (status === 401 || (status === 400 && (error === 'invalid-payload' || error === 'verification_failed'))) return fail('refused');
  return fail('other');
}

// ─── Building a goal from the form ─────────────────────────────────

/** The live loans a goal may be attached to: those whose lender side the
 *  wallet holds, in a token. */
export function goalLoans(rows: readonly LiveLoanRow[]): LiveLoanRow[] {
  return rows.filter((r) => !r.borrowerSide && r.loan.assetType === ASSET_ERC20 && r.loan.id <= BigInt(Number.MAX_SAFE_INTEGER));
}

export type GoalFormProblem = 'name' | 'no-loans' | 'mixed-tokens' | 'no-slot' | 'amount' | 'date' | 'past';

/** What the form attaches the goal to: loans by id, or one of the wallet's
 *  Auto-lend slots by its pair and number. */
export type FormAttach = { kind: 'loans'; loanIds: readonly bigint[] } | { kind: 'slot'; slot: SlotRef | null };

export interface SlotRef {
  lendingAsset: Hex;
  collateralAsset: Hex;
  slot: number;
}

export function slotKey(s: SlotRef): string {
  return `${s.lendingAsset.toLowerCase()}:${s.collateralAsset.toLowerCase()}:${s.slot}`;
}

/** The token a goal attached as the form says would be counted in, or null
 *  when nothing usable is chosen. */
export function formAsset(attach: FormAttach, rows: readonly LiveLoanRow[]): Hex | null {
  if (attach.kind === 'slot') return attach.slot?.lendingAsset ?? null;
  return goalLoans(rows).find((r) => attach.loanIds.includes(r.loan.id))?.loan.principalAsset ?? null;
}

/** The goal the form describes, or why it cannot be saved. Every chosen loan
 *  must be in one token: the target is counted in it. A slot's target is in
 *  its lending token. */
export function goalFromForm(
  form: { name: string; target: bigint | null; date: number | null; attach: FormAttach },
  rows: readonly LiveLoanRow[],
  nowSec: number,
): { ok: true; goal: GoalInput } | { ok: false; problem: GoalFormProblem } {
  let asset: string;
  let attachTo: GoalInput['attachTo'];
  if (form.attach.kind === 'slot') {
    const s = form.attach.slot;
    if (s === null) return { ok: false, problem: 'no-slot' };
    asset = s.lendingAsset.toLowerCase();
    attachTo = { kind: 'slot', lendingAsset: s.lendingAsset, collateralAsset: s.collateralAsset, slot: s.slot };
  } else {
    const ids = form.attach.loanIds;
    const chosen = goalLoans(rows).filter((r) => ids.includes(r.loan.id));
    if (chosen.length === 0) return { ok: false, problem: 'no-loans' };
    asset = chosen[0].loan.principalAsset.toLowerCase();
    if (chosen.some((r) => r.loan.principalAsset.toLowerCase() !== asset)) return { ok: false, problem: 'mixed-tokens' };
    attachTo = { kind: 'loans', loanIds: chosen.map((r) => Number(r.loan.id)) };
  }
  if (form.target === null || form.target <= 0n) return { ok: false, problem: 'amount' };
  if (form.date === null) return { ok: false, problem: 'date' };
  if (form.date <= nowSec) return { ok: false, problem: 'past' };
  const goal = checkedGoal({ name: form.name.trim(), asset, targetAmount: form.target.toString(), targetDate: form.date, attachTo });
  if (goal === null) return { ok: false, problem: 'name' };
  return { ok: true, goal };
}

// ─── Progress ──────────────────────────────────────────────────────

export type GoalProgress =
  | {
      kind: 'loans';
      /** Principal still out in the attached loans the wallet holds now, in
       *  the goal's token. A floor when `complete` is false. */
      counted: bigint;
      /** Attached loans found among the live positions and counted. */
      countedLoans: number;
      /** Attached loans not among the live positions read: ended, given
       *  away, or (when the read was partial) not read. */
      notFound: number;
      /** Whether the live positions were read in full. */
      complete: boolean;
      reached: boolean;
    }
  | { kind: 'slot'; waiting: bigint; lent: bigint; active: boolean; reached: boolean }
  /** The slot is not among the wallet's listed slots (the list was cut short
   *  at its limit, or nothing was ever set on that pair and number). */
  | { kind: 'slot-missing'; complete: boolean };

export function loansProgress(goal: Goal, rows: readonly LiveLoanRow[], complete: boolean): GoalProgress | null {
  if (goal.attachTo.kind !== 'loans') return null;
  const held = new Map(goalLoans(rows).map((r) => [r.loan.id, r]));
  let counted = 0n;
  let countedLoans = 0;
  let notFound = 0;
  for (const id of goal.attachTo.loanIds) {
    const r = held.get(BigInt(id));
    if (!r) {
      notFound += 1;
      continue;
    }
    if (r.loan.principalAsset.toLowerCase() !== goal.asset.toLowerCase()) continue;
    counted += r.loan.principal;
    countedLoans += 1;
  }
  return { kind: 'loans', counted, countedLoans, notFound, complete, reached: complete && counted >= BigInt(goal.targetAmount) };
}

export function slotProgress(goal: Goal, slots: readonly MyAutoLend[], complete: boolean): GoalProgress | null {
  const a = goal.attachTo;
  if (a.kind !== 'slot') return null;
  const want = slotKey({ lendingAsset: a.lendingAsset as Hex, collateralAsset: a.collateralAsset as Hex, slot: a.slot });
  const hit = slots.find((r) => slotKey(r.intent) === want);
  if (!hit) return { kind: 'slot-missing', complete };
  const { availableCapital: waiting, livePrincipal: lent } = hit.intent;
  return { kind: 'slot', waiting, lent, active: hit.active, reached: waiting + lent >= BigInt(goal.targetAmount) };
}
