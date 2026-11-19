/**
 * #3761 — the Lend form's pre-selected choices (`DefaultPathsDesign.md` §3).
 *
 * A default is the pre-selected choice in a form the lender reviews and
 * signs; nothing is lent because a lender stayed silent. Each choice below is
 * a switch on the form and a line on the review, and each one that is on adds
 * its own step to the ONE batch that sets the Auto-lend slot:
 *
 * - **Re-lend repayments for me**: the platform's keeper gets the roll action
 *   (`KEEPER_ACTION_AUTO_ROLL`) and nothing else, added to what it already
 *   holds. Keeper access is switched on only where no other approval exists
 *   for it to bring back; where the wallet switched access off and still has
 *   keepers approved, the line is NOT pre-selected, and switching it on needs
 *   the list of every keeper and the actions it would regain confirmed.
 *   Never offered where the platform token is the lending asset (the protocol
 *   never rolls it).
 * - **Interest by time**: the slot's `acceptsProRata`.
 * - **Fill instant borrows / Renew loans this slot made / Take over other
 *   lenders' loans at face value**: the instant market's three consents
 *   (`setInstantSlot`), three separate switches. They need interest by time,
 *   the market on for the network and a top-tier pair; otherwise they are off
 *   and the reason is stated.
 *
 * Everything here is pure or a read; the form and the review build on it.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { InstantMarketFacetABI } from '@vaipakam/contracts/abis';
import { refusalFromError } from '../eligibility/refusal';
import { chainValidUntil } from '../tx/deadline';
import { isRevert } from '../tx/simulate';
import { VPFITokenFacetABI } from '@vaipakam/contracts/abis';
import { changeCall, networkKeeper, PROFILE_ABI, MAX_KEEPERS, readKeeperSettings, type KeeperChange, type KeeperGrant, type KeeperSettings } from '../keepers/keepers';
import type { BatchStep } from '../tx/batch';

type Hex = `0x${string}`;

export const INSTANT = InstantMarketFacetABI as Abi;

/** The protocol's `KEEPER_ACTION_AUTO_ROLL` bit. */
export const AUTO_ROLL = 1 << 7;

/** The lender's choices, as switched on the form. */
export interface LendPreset {
  relend: boolean;
  proRata: boolean;
  fills: boolean;
  renewal: boolean;
  takeover: boolean;
}

/** The form as shipped: every choice pre-selected. */
export const PRESELECTED: LendPreset = { relend: true, proRata: true, fills: true, renewal: true, takeover: true };

/** Whether the instant market can take this pair's slot on this network.
 *  `unknown` is any reading the app cannot name: the switches stay off and
 *  the form says it is not known, never a guess. */
export type InstantAvailability = 'available' | 'market-off' | 'pair-not-eligible' | 'unknown';

/** What "Re-lend repayments for me" means for this wallet now. */
export type RelendState =
  /** Keeper access on and the platform's keeper already holds the roll. */
  | { kind: 'given' }
  /** The platform token is the lending asset: the protocol never rolls it. */
  | { kind: 'vpfi' }
  /** The keeper settings could not be read. */
  | { kind: 'unknown' }
  /** This network's deployment record names no platform keeper. */
  | { kind: 'no-keeper' }
  /** The platform's keeper is not approved and the wallet holds the most
   *  approvals the protocol allows. */
  | { kind: 'full' }
  /** The changes the batch would carry. `regain` lists every keeper approval
   *  that switching keeper access back on would bring back (empty when access
   *  is on or nothing is approved); a non-empty list must be confirmed. */
  | { kind: 'grant'; changes: KeeperChange[]; regain: KeeperGrant[] };

/** The re-lend line's state from the wallet's keeper settings. */
export function relendState(settings: KeeperSettings | null, keeper: Hex | null, vpfi: boolean | null): RelendState {
  if (vpfi === true) return { kind: 'vpfi' };
  if (keeper === null) return { kind: 'no-keeper' };
  if (vpfi === null || settings === null) return { kind: 'unknown' };
  const grant = settings.keepers.find((k) => k.keeper.toLowerCase() === keeper.toLowerCase()) ?? null;
  const holdsRoll = grant !== null && (grant.actions & AUTO_ROLL) !== 0;
  if (settings.access && holdsRoll) return { kind: 'given' };
  const changes: KeeperChange[] = [];
  if (grant === null) {
    if (settings.keepers.length >= MAX_KEEPERS) return { kind: 'full' };
    changes.push({ kind: 'approve', keeper, actions: AUTO_ROLL });
  } else if (!holdsRoll) {
    changes.push({ kind: 'actions', keeper, actions: grant.actions | AUTO_ROLL });
  }
  if (!settings.access) changes.push({ kind: 'access', on: true });
  return { kind: 'grant', changes, regain: settings.access ? [] : settings.keepers };
}

/** A key for the keeper list a lender confirmed: a list that moved after the
 *  confirmation is not the list confirmed. */
export function regainKey(regain: readonly KeeperGrant[]): string {
  return regain
    .map((g) => `${g.keeper.toLowerCase()}:${g.actions}`)
    .sort()
    .join(',');
}

/** Whether the re-lend line opens pre-selected: everywhere it can be given,
 *  except where switching access on would bring other approvals back. */
export function relendPreselected(state: RelendState): boolean {
  return state.kind === 'grant' && state.regain.length === 0;
}

/** The choices the form opens on: the lender's remembered choices, or the
 *  pre-selected ones, with the re-lend line off where it may not open on. */
export function openingPreset(remembered: LendPreset | null, state: RelendState | null): LendPreset {
  const base = remembered ?? PRESELECTED;
  return { ...base, relend: base.relend && (state === null || state.kind === 'given' || relendPreselected(state)) };
}

/** Why an instant-market switch is off whatever the lender chose; null when
 *  the lender's choice stands. */
export type InstantOff = 'needs-pro-rata' | 'market-off' | 'pair-not-eligible' | 'unknown' | 'solver-only';

export function instantOff(proRata: boolean, availability: InstantAvailability, solverOnly = false): InstantOff | null {
  if (availability === 'market-off') return 'market-off';
  if (availability === 'pair-not-eligible') return 'pair-not-eligible';
  if (availability === 'unknown') return 'unknown';
  if (solverOnly) return 'solver-only';
  if (!proRata) return 'needs-pro-rata';
  return null;
}

/** What the batch actually sets, from the choices and the facts read. */
export interface EffectivePreset {
  proRata: boolean;
  fills: boolean;
  renewal: boolean;
  takeover: boolean;
  /** The keeper changes the batch carries (empty when none). */
  keeper: KeeperChange[];
  /** The re-lend outcome the review states. */
  relend: 'given' | 'granted' | 'off' | 'vpfi' | 'unknown' | 'no-keeper' | 'full' | 'unconfirmed';
}

/** The choices as the batch carries them. `confirmed` is the `regainKey` the
 *  lender confirmed, or null. */
export function effectivePreset(p: LendPreset, state: RelendState, availability: InstantAvailability, confirmed: string | null): EffectivePreset {
  const off = instantOff(p.proRata, availability);
  const instant = off === null;
  let keeper: KeeperChange[] = [];
  let relend: EffectivePreset['relend'];
  switch (state.kind) {
    case 'given':
    case 'vpfi':
    case 'unknown':
    case 'no-keeper':
    case 'full':
      relend = state.kind;
      break;
    case 'grant':
      if (!p.relend) relend = 'off';
      else if (state.regain.length > 0 && confirmed !== regainKey(state.regain)) relend = 'unconfirmed';
      else {
        relend = 'granted';
        keeper = state.changes;
      }
      break;
  }
  return { proRata: p.proRata, fills: instant && p.fills, renewal: instant && p.renewal, takeover: instant && p.takeover, keeper, relend };
}

/** A change of an existing slot's terms: setting the terms clears the
 *  slot's instant-market consents, so the batch sends again the ones it had
 *  (`DefaultPathsDesign.md` §3.4), where they can still be sent. It changes
 *  no keeper permission. `cleared` when the slot had a consent the batch
 *  cannot send again (interest by time switched off, or the market no longer
 *  takes the pair): the review says so. An availability that could not be
 *  read sends them again and lets the dry run decide. */
export function changeEffective(
  record: InstantSlotRecord | null,
  proRata: boolean,
  availability: InstantAvailability,
  state: RelendState,
): { effective: EffectivePreset; cleared: boolean } {
  const relend: EffectivePreset['relend'] = state.kind === 'given' || state.kind === 'vpfi' || state.kind === 'unknown' || state.kind === 'no-keeper' ? state.kind : 'off';
  const none = { proRata, fills: false, renewal: false, takeover: false, keeper: [], relend };
  if (record === null || !anyInstant(record)) return { effective: none, cleared: false };
  if (!proRata || availability === 'market-off' || availability === 'pair-not-eligible') return { effective: none, cleared: true };
  return { effective: { ...none, fills: record.fills, renewal: record.renewal, takeover: record.takeover }, cleared: false };
}

/** Whether any instant-market consent is on. */
export function anyInstant(e: Pick<EffectivePreset, 'fills' | 'renewal' | 'takeover'>): boolean {
  return e.fills || e.renewal || e.takeover;
}

/** The steps the choices add to the slot's batch, after its terms and its
 *  funding: the instant-market consents (they need the slot active and taking
 *  interest by time, which the terms set in the same batch), then the keeper
 *  changes. */
export function presetSteps(e: EffectivePreset, lending: Hex, collateral: Hex, slot: number, validUntil: bigint): BatchStep[] {
  const steps: BatchStep[] = [];
  if (anyInstant(e)) steps.push({ abi: INSTANT, functionName: 'setInstantSlot', args: [lending, collateral, slot, e.fills, e.renewal, e.takeover, true, validUntil] });
  for (const c of e.keeper) {
    const call = changeCall(c);
    steps.push({ abi: PROFILE_ABI, functionName: call.functionName, args: call.args });
  }
  return steps;
}

/** A slot's instant-market consents as recorded. */
export interface InstantSlotRecord {
  fills: boolean;
  renewal: boolean;
  takeover: boolean;
  setAt: bigint;
}

export async function readInstantSlot(c: PublicClient, diamond: Hex, owner: Hex, lending: Hex, collateral: Hex, slot: number, blockNumber?: bigint): Promise<InstantSlotRecord> {
  const r = (await c.readContract({ address: diamond, abi: INSTANT, functionName: 'getInstantSlot', args: [owner, lending, collateral, slot], blockNumber })) as InstantSlotRecord;
  return { fills: r.fills, renewal: r.renewal, takeover: r.takeover, setAt: r.setAt };
}

/** The revert names the eligibility probe tells apart. Until the protocol
 *  carries a view of its own, a dry run of the fills consent on a slot that
 *  does not yet exist stops at the first check that fails: the market switch,
 *  then the pair, then the slot itself. A refusal for the missing slot (or
 *  for its interest mode) means the pair passed; any other refusal (the
 *  wallet's own standing, the Terms) cannot say, so it reads as unknown. */
export function availabilityFromProbe(outcome: { kind: 'ok' } | { kind: 'reverted'; name: string | null } | { kind: 'unreadable' }): InstantAvailability {
  if (outcome.kind === 'ok') return 'available';
  if (outcome.kind === 'unreadable') return 'unknown';
  switch (outcome.name) {
    case 'InstantMarketDisabled':
      return 'market-off';
    case 'InstantPairNotEligible':
      return 'pair-not-eligible';
    case 'InstantSlotInactive':
    case 'InstantSlotNeedsProRata':
    case 'InstantSlotSolverOnly':
      return 'available';
    default:
      return 'unknown';
  }
}

/** Reads whether the instant market can take the pair: the market's own
 *  switch first, then the probe as a dry run from the wallet. A failure that
 *  is not the contract's refusal reads as unknown. */
export async function readInstantAvailability(c: PublicClient, diamond: Hex, account: Hex, lending: Hex, collateral: Hex, slot: number): Promise<InstantAvailability> {
  let enabled: boolean;
  try {
    const cfg = (await c.readContract({ address: diamond, abi: INSTANT, functionName: 'getInstantMarketConfig' })) as readonly [boolean, number];
    enabled = cfg[0];
  } catch {
    return 'unknown';
  }
  if (!enabled) return 'market-off';
  try {
    await c.simulateContract({
      address: diamond,
      abi: INSTANT,
      functionName: 'setInstantSlot',
      args: [lending, collateral, slot, true, false, false, true, await chainValidUntil(c)],
      account,
    });
    return availabilityFromProbe({ kind: 'ok' });
  } catch (e) {
    if (!isRevert(e)) return availabilityFromProbe({ kind: 'unreadable' });
    return availabilityFromProbe({ kind: 'reverted', name: refusalFromError(e).code });
  }
}

const VPFI_TOKEN = VPFITokenFacetABI as Abi;

/** What the pre-selected choices stand on for this wallet and pair. */
export interface PresetFacts {
  relend: RelendState;
  instant: InstantAvailability;
  /** The platform's keeper on this network, from the deployment record. */
  keeper: Hex | null;
}

/** Reads the facts through one client. Each part that cannot be read reads
 *  as unknown (never thrown), so the form still opens and says so. */
export async function readPresetFacts(c: PublicClient, diamond: Hex, account: Hex, chainId: number, lending: Hex, collateral: Hex, slot: number): Promise<PresetFacts> {
  const keeper = networkKeeper(chainId);
  const [vpfi, settings, instant] = await Promise.all([
    (c.readContract({ address: diamond, abi: VPFI_TOKEN, functionName: 'getVPFIToken' }) as Promise<Hex>).then(
      (v) => v.toLowerCase() === lending.toLowerCase(),
      () => null,
    ),
    readKeeperSettings(c, diamond, account).catch(() => null),
    readInstantAvailability(c, diamond, account, lending, collateral, slot),
  ]);
  return { relend: relendState(settings, keeper, vpfi), instant, keeper };
}

/** A key for the facts, so a review that read different ones says so. */
export function presetFactsKey(f: PresetFacts): string {
  const r = f.relend;
  const relend = r.kind === 'grant' ? `grant:${r.changes.map((c) => JSON.stringify(c)).join(';')}:${regainKey(r.regain)}` : r.kind;
  return `${relend}|${f.instant}`;
}

/** The line a remembered choice is kept under, per wallet and network. */
export function presetStoreKey(chainId: number, account: Hex): string {
  return `vaipakam.lendPreset.${chainId}.${account.toLowerCase()}`;
}

/** What the device remembers: the form the lender last chose and its
 *  switches. */
export interface RememberedLend {
  runs: 'once' | 'keep';
  preset: LendPreset;
}

export function parseRemembered(raw: string | null): RememberedLend | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<RememberedLend> & { preset?: Partial<LendPreset> };
    if (v.runs !== 'once' && v.runs !== 'keep') return null;
    const p = v.preset;
    if (!p) return null;
    const keys: (keyof LendPreset)[] = ['relend', 'proRata', 'fills', 'renewal', 'takeover'];
    if (!keys.every((k) => typeof p[k] === 'boolean')) return null;
    return { runs: v.runs, preset: { relend: p.relend!, proRata: p.proRata!, fills: p.fills!, renewal: p.renewal!, takeover: p.takeover! } };
  } catch {
    return null;
  }
}

/** Reads the remembered choice; null when none is kept or storage is shut. */
export function loadRemembered(chainId: number, account: Hex): RememberedLend | null {
  try {
    return parseRemembered(globalThis.localStorage?.getItem(presetStoreKey(chainId, account)) ?? null);
  } catch {
    return null;
  }
}

/** Keeps the choice for the next visit on this device (best effort). */
export function saveRemembered(chainId: number, account: Hex, value: RememberedLend): void {
  try {
    globalThis.localStorage?.setItem(presetStoreKey(chainId, account), JSON.stringify(value));
  } catch {
    // Storage shut: the form opens on the pre-selected choices next time.
  }
}

/** Keeps which form the lender chose, leaving the remembered switches. */
export function rememberRuns(chainId: number, account: Hex, runs: 'once' | 'keep'): void {
  saveRemembered(chainId, account, { runs, preset: loadRemembered(chainId, account)?.preset ?? PRESELECTED });
}

/** What the batch's own logs record of the choices: the instant-market
 *  consents set on this slot, and the platform keeper's actions and the
 *  wallet's keeper access as changed (null where no such log). */
export interface PresetLogs {
  instant: { fills: boolean; renewal: boolean; takeover: boolean } | null;
  keeperActions: number | null;
  access: boolean | null;
}

export function presetLogs(logs: readonly Log[], diamond: Hex, account: Hex, lending: Hex, collateral: Hex, slot: number, keeper: Hex | null): PresetLogs {
  const same = (a: unknown, b: Hex) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const mine = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase()) as Log[];
  const events = [...parseEventLogs({ abi: INSTANT, logs: mine, strict: false }), ...parseEventLogs({ abi: PROFILE_ABI, logs: mine, strict: false })] as unknown as {
    eventName: string;
    args: Record<string, unknown>;
  }[];
  const out: PresetLogs = { instant: null, keeperActions: null, access: null };
  for (const e of events) {
    const a = e.args;
    if (e.eventName === 'InstantSlotSet' && same(a.owner, account) && same(a.lendingAsset, lending) && same(a.collateralAsset, collateral) && Number(a.slot) === slot)
      out.instant = { fills: a.fills === true, renewal: a.renewal === true, takeover: a.takeover === true };
    if (e.eventName === 'KeeperActionsUpdated' && keeper !== null && same(a.user, account) && same(a.keeper, keeper)) out.keeperActions = Number(a.actions);
    if (e.eventName === 'KeeperAccessUpdated' && same(a.user, account)) out.access = a.enabled === true;
  }
  return out;
}
