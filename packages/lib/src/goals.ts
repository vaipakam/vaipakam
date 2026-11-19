/**
 * #3771 — goals (FeaturesOverExistingPartsDesign.md §4).
 *
 * A goal is the user's own note: a name, a target amount of one asset and a
 * date, attached to an auto-lend slot or to loans the wallet made. It locks
 * nothing and changes nothing on chain. The agent stores it for the wallet,
 * every write and every read is signed by the wallet, and nothing else can
 * see it.
 *
 * This module is the ONE source of what the app and the agent must agree on
 * byte for byte: the goal's checked shape and the messages a wallet signs to
 * save, delete and list goals (the `alertsMessage.ts` discipline, #2014).
 * A save message names every value it saves, so a signature authorises those
 * values and no others; the goal's name is checked to a single plain line
 * before it is placed in a message, so it cannot add a line of its own.
 *
 * The app builds the save message from what {@link parseGoalInput} returns
 * (the addresses lower-cased, loan ids de-duplicated and sorted), exactly as the
 * agent does, so both sides sign and check the same text.
 */

/** Default limits; the agent reads its own configuration first. */
export const GOALS_DEFAULT_MAX_PER_WALLET = 20;
export const GOALS_DEFAULT_MAX_CHANGES_PER_DAY = 50;
/** The most loans one goal may be attached to. */
export const GOAL_MAX_LOANS = 50;
/** The longest goal name, in characters. */
export const GOAL_NAME_MAX = 60;

/** The highest Auto-lend slot number: an owner has slots 0 to this for each
 *  (lending asset, collateral asset) pair. */
export const GOAL_MAX_SLOT = 7;

/** What a goal is attached to. An Auto-lend slot is named on chain by the
 *  owner, the pair and its number, so a goal names the pair and the number
 *  (the owner is the wallet that signs); addresses are lower-cased. */
export type GoalAttachment =
  | { kind: 'slot'; lendingAsset: string; collateralAsset: string; slot: number }
  | { kind: 'loans'; loanIds: number[] };

/** A goal as the wallet saves it. */
export interface GoalInput {
  name: string;
  /** The asset the target is counted in. */
  asset: string;
  /** The target, in the asset's smallest unit, as a decimal string. */
  targetAmount: string;
  /** The date, in Unix seconds. */
  targetDate: number;
  attachTo: GoalAttachment;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^[1-9][0-9]{0,77}$/;
const MAX_ID = Number.MAX_SAFE_INTEGER;
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_ID;

/** A name is one plain line: no control characters, no line breaks, trimmed,
 *  1 to {@link GOAL_NAME_MAX} characters. */
export function goalNameOk(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name !== name.trim() || name.length === 0) return false;
  if ([...name].length > GOAL_NAME_MAX) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name);
}

/** Check a goal from a request body. A reason names the first problem. */
export function parseGoalInput(raw: unknown): { ok: true; goal: GoalInput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'goal must be an object' };
  const g = raw as Record<string, unknown>;
  if (!goalNameOk(g.name)) return { ok: false, reason: `name must be one plain line of 1 to ${GOAL_NAME_MAX} characters` };
  if (typeof g.asset !== 'string' || !ADDRESS.test(g.asset)) return { ok: false, reason: 'asset must be an address' };
  if (typeof g.targetAmount !== 'string' || !AMOUNT.test(g.targetAmount)) {
    return { ok: false, reason: 'targetAmount must be a positive whole number in the asset’s smallest unit' };
  }
  if (!Number.isInteger(g.targetDate) || (g.targetDate as number) <= 0 || (g.targetDate as number) > 4_102_444_800) {
    return { ok: false, reason: 'targetDate must be a Unix time before 2100' };
  }
  const a = g.attachTo as Record<string, unknown> | undefined;
  let attachTo: GoalAttachment;
  if (
    a &&
    a.kind === 'slot' &&
    typeof a.lendingAsset === 'string' &&
    ADDRESS.test(a.lendingAsset) &&
    typeof a.collateralAsset === 'string' &&
    ADDRESS.test(a.collateralAsset) &&
    Number.isInteger(a.slot) &&
    (a.slot as number) >= 0 &&
    (a.slot as number) <= GOAL_MAX_SLOT
  ) {
    attachTo = {
      kind: 'slot',
      lendingAsset: a.lendingAsset.toLowerCase(),
      collateralAsset: a.collateralAsset.toLowerCase(),
      slot: a.slot as number,
    };
  } else if (
    a &&
    a.kind === 'loans' &&
    Array.isArray(a.loanIds) &&
    a.loanIds.length >= 1 &&
    a.loanIds.length <= GOAL_MAX_LOANS &&
    a.loanIds.every(isId)
  ) {
    const ids = [...new Set(a.loanIds as number[])].sort((x, y) => x - y);
    attachTo = { kind: 'loans', loanIds: ids };
  } else {
    return {
      ok: false,
      reason: `attachTo must be an Auto-lend slot (lending asset, collateral asset, slot 0 to ${GOAL_MAX_SLOT}) or 1 to ${GOAL_MAX_LOANS} loan ids`,
    };
  }
  return {
    ok: true,
    goal: { name: g.name, asset: g.asset.toLowerCase(), targetAmount: g.targetAmount, targetDate: g.targetDate as number, attachTo },
  };
}

const footer = (wallet: string, chainId: number, issuedAt: number) => [
  '',
  `Wallet: ${wallet.toLowerCase()}`,
  `Chain id: ${chainId}`,
  `Issued at (unix): ${issuedAt}`,
];

const attachmentLines = (a: GoalAttachment): string[] =>
  a.kind === 'slot'
    ? [
        `Attached to: auto-lend slot ${a.slot}`,
        `Slot lending asset: ${a.lendingAsset.toLowerCase()}`,
        `Slot collateral asset: ${a.collateralAsset.toLowerCase()}`,
      ]
    : [`Attached to: loans ${a.loanIds.join(', ')}`];

/**
 * Save a goal: a new one (`goalId` null) or a change to one. The goal must
 * already have passed {@link parseGoalInput}; the message is built from the
 * checked values, which are the values stored.
 */
export function buildSaveGoalMessage(wallet: string, chainId: number, goalId: number | null, goal: GoalInput, issuedAt: number): string {
  return [
    'Vaipakam — Save a goal',
    '',
    'I request that the goal below be saved for the wallet below. A goal',
    'is a private note: it locks nothing and changes nothing on chain.',
    'Signing this message proves ownership of the wallet. It is not a',
    'transaction and costs no gas.',
    '',
    `Goal: ${goalId === null ? 'new' : `id ${goalId}`}`,
    `Name: ${goal.name}`,
    `Target: ${goal.targetAmount} (smallest unit) of ${goal.asset.toLowerCase()}`,
    `By (unix): ${goal.targetDate}`,
    ...attachmentLines(goal.attachTo),
    ...footer(wallet, chainId, issuedAt),
  ].join('\n');
}

/** Delete one goal. */
export function buildDeleteGoalMessage(wallet: string, chainId: number, goalId: number, issuedAt: number): string {
  return [
    'Vaipakam — Delete a goal',
    '',
    'I request that the goal below be deleted for the wallet below.',
    'Signing this message proves ownership of the wallet. It is not a',
    'transaction and costs no gas.',
    '',
    `Goal: id ${goalId}`,
    ...footer(wallet, chainId, issuedAt),
  ].join('\n');
}

/** List the wallet's goals: they are private, so reading is signed too. */
export function buildListGoalsMessage(wallet: string, chainId: number, issuedAt: number): string {
  return [
    'Vaipakam — Show my goals',
    '',
    'I request the goals saved for the wallet below. Signing this',
    'message proves ownership of the wallet. It is not a transaction and',
    'costs no gas.',
    ...footer(wallet, chainId, issuedAt),
  ].join('\n');
}
