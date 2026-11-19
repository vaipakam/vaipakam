/**
 * #3771 — the routes a wallet keeps its goals through
 * (FeaturesOverExistingPartsDesign.md §4).
 *
 *   POST /goals/save     save a new goal, or change one    (signed over every value)
 *   POST /goals/delete   delete one goal                   (signed, names the goal)
 *   POST /goals/list     the wallet's goals                (signed: goals are private)
 *
 * Body: `{ wallet, chain_id, issuedAt, signature, goalId?, goal? }`, signed
 * over the messages in `@vaipakam/lib/goals` and claimed once, like every
 * signed request here. A goal is a note: nothing here reads or changes the
 * chain, and nothing here locks anything.
 *
 * LIMITS. At most `GOALS_MAX_PER_WALLET` goals per wallet and
 * `GOALS_MAX_CHANGES_PER_DAY` saves and deletes a day, checked inside the
 * state object together with the write.
 */
import {
  GOALS_DEFAULT_MAX_CHANGES_PER_DAY,
  GOALS_DEFAULT_MAX_PER_WALLET,
  parseGoalInput,
  type GoalInput,
} from '@vaipakam/lib/goals';
import {
  parseSignedLinkRequest,
  type AlertAuthorisation,
  type LinkVerifyResult,
  type SignedLinkRequest,
} from './linkAuth';
import type { ChainDeployment } from './telegramState/store';
import type { Goal, GoalDeleteOutcome, GoalLimits, GoalSaveOutcome } from './telegramState/goals';

export const GOAL_PATHS = ['/goals/save', '/goals/delete', '/goals/list'] as const;
export type GoalPath = (typeof GOAL_PATHS)[number];

export function isGoalPath(path: string): path is GoalPath {
  return (GOAL_PATHS as readonly string[]).includes(path);
}

export interface GoalStatePort {
  saveGoal(dep: ChainDeployment, wallet: string, id: number | null, goal: GoalInput, now: number, limits: GoalLimits): Promise<GoalSaveOutcome> | GoalSaveOutcome;
  deleteGoal(dep: ChainDeployment, wallet: string, id: number, now: number, limits: GoalLimits): Promise<GoalDeleteOutcome> | GoalDeleteOutcome;
  listGoals(wallet: string, deps: ChainDeployment[]): Promise<Goal[]> | Goal[];
}

export interface GoalRouteDeps {
  state: GoalStatePort;
  authorise: (req: SignedLinkRequest, auth: AlertAuthorisation) => Promise<LinkVerifyResult>;
  deployments: () => ChainDeployment[];
  limits: GoalLimits;
  now: () => number;
}

export interface GoalAnswer {
  status: number;
  body: Record<string, unknown>;
}

function limitOf(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : fallback;
}

/** The limits from this agent's configuration, with the defaults. */
export function goalLimitsOf(env: { GOALS_MAX_PER_WALLET?: string; GOALS_MAX_CHANGES_PER_DAY?: string }): GoalLimits {
  return {
    maxPerWallet: limitOf(env.GOALS_MAX_PER_WALLET, GOALS_DEFAULT_MAX_PER_WALLET),
    maxChangesPerDay: limitOf(env.GOALS_MAX_CHANGES_PER_DAY, GOALS_DEFAULT_MAX_CHANGES_PER_DAY),
  };
}

const refused = (status: number, error: string, extra: Record<string, unknown> = {}): GoalAnswer => ({
  status,
  body: { error, ...extra },
});

function verifyRefusal(v: Extract<LinkVerifyResult, { ok: false }>): GoalAnswer {
  const error = v.status === 409 ? 'request-already-used' : v.status === 503 ? 'verification-unavailable' : 'verification_failed';
  return refused(v.status, error, { reason: v.reason });
}

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= Number.MAX_SAFE_INTEGER;

/** Answer one goal route. */
export async function handleGoalRoute(path: GoalPath, body: unknown, d: GoalRouteDeps): Promise<GoalAnswer> {
  const parsed = parseSignedLinkRequest(body);
  if (!parsed.ok) return refused(400, 'invalid-payload', { reason: parsed.reason });
  const req = parsed.req;
  const b = body as Record<string, unknown>;

  if (path === '/goals/list') {
    const v = await d.authorise(req, 'list-goals');
    if (!v.ok) return verifyRefusal(v);
    return { status: 200, body: { goals: await d.state.listGoals(req.wallet, d.deployments()), limits: d.limits } };
  }

  const dep = d.deployments().find((x) => x.chainId === req.chain_id);
  if (!dep) return refused(400, 'chain-not-served');

  if (path === '/goals/delete') {
    if (!isId(b.goalId)) return refused(400, 'invalid-payload', { reason: 'goalId must be a positive whole number' });
    const v = await d.authorise(req, { action: 'delete-goal', goalId: b.goalId });
    if (!v.ok) return verifyRefusal(v);
    const out = await d.state.deleteGoal(dep, req.wallet, b.goalId, d.now(), d.limits);
    if (out === 'deleted') return { status: 200, body: { ok: true } };
    if (out === 'not-found') return refused(404, 'goal-not-found');
    return refused(429, 'changes-spent', { limit: d.limits.maxChangesPerDay });
  }

  // Save.
  const goalId = b.goalId === undefined || b.goalId === null ? null : b.goalId;
  if (goalId !== null && !isId(goalId)) return refused(400, 'invalid-payload', { reason: 'goalId must be a positive whole number or absent' });
  const goal = parseGoalInput(b.goal);
  if (!goal.ok) return refused(400, 'invalid-payload', { reason: goal.reason });
  // The signature is checked against the CHECKED values, which are the ones
  // stored, so what the wallet signed and what is kept cannot differ.
  const v = await d.authorise(req, { action: 'save-goal', goalId, goal: goal.goal });
  if (!v.ok) return verifyRefusal(v);
  const out = await d.state.saveGoal(dep, req.wallet, goalId, goal.goal, d.now(), d.limits);
  switch (out.kind) {
    case 'saved':
      return { status: 200, body: { ok: true, id: out.id } };
    case 'not-found':
      return refused(404, 'goal-not-found');
    case 'too-many-goals':
      return refused(409, 'too-many-goals', { limit: d.limits.maxPerWallet });
    case 'changes-spent':
      return refused(429, 'changes-spent', { limit: d.limits.maxChangesPerDay });
  }
}
