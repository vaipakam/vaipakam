/**
 * ACC-53 — paid push billing consent (#3180 Alerts slice 3; RB-PAID-PUSH).
 *
 * A wallet agrees, on chain, to the most VPFI it will pay per loan side for
 * paid push alerts; zero withdraws. The fee is flat VPFI configured on each
 * network, taken from the wallet's free vault VPFI at most once per loan side
 * on its first paid push alert. The protection is the CAP: a fee rise within
 * the cap is charged without a new agreement, and a cap at the protocol's
 * ceiling accepts any fee governance can set.
 *
 * What the review stands on is read at one block through the wallet's
 * connection: the fee now, the stored cap and whether the contract judges it
 * covers the fee, and the wallet's standing with the sanctions screen. The
 * free VPFI in the vault is read beside it, for the low-balance warning only.
 * Whether the alert service bills on this network comes from its push status
 * answer (`billedChainIds`), never assumed.
 */
import { formatUnits, parseEventLogs, parseUnits, type Abi, type Log, type PublicClient } from 'viem';
import { ConfigFacetABI, NotificationFeeFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { readFreeVpfi } from '../offers/fullTariff';
import type { Receipt, ReceiptRow, ReceiptText } from '../receipt/types';
import { frozenState, isFrozenRefusal, readSanctionsPosture, type FrozenState } from '../sanctions/posture';
import { askThrough } from '../tx/simulate';
import type { LegOutcome } from '../tx/outcome';
import type { PushStatus } from './alerts';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export const NOTIFICATION_FEE = NotificationFeeFacetABI as Abi;
const CONFIG = ConfigFacetABI as Abi;

/** VPFI has 18 decimals on every network. */
export const VPFI_DECIMALS = 18;

/** The protocol's ceiling on a consent cap (`MAX_NOTIFICATION_FEE_CEIL`,
 *  50 VPFI): a cap above it is refused, and a cap AT it accepts any fee
 *  governance can set. A constant in the protocol, so a constant here. */
export const CONSENT_CEILING = 50n * 10n ** 18n;

/** The consent setter's and the bill's signatures, for the deployment's
 *  routing check: an older deployment without the setter has no consent
 *  record, and whether it can still bill is told by whether it routes the
 *  bill. */
export const CONSENT_SIGNATURE = 'setNotificationFeeConsent(uint256)';
export const BILL_SIGNATURE = 'markNotifBilled(uint256,bool)';

/** What the contract holds for the wallet, read at one block. */
export interface PaidPushFacts {
  /** The fee per loan side configured on this network now (VPFI, 18 dec). */
  fee: bigint;
  /** The wallet's stored cap; zero is no agreement. */
  cap: bigint;
  /** Whether the contract judges the cap covers the fee now. */
  covers: boolean;
  frozen: FrozenState;
}

export interface PaidPushRead extends PaidPushFacts {
  /** The free VPFI the bill could take from the vault; null when it could
   *  not be read (never shown as zero). */
  freeVpfi: bigint | null;
  readAt: number;
}

export async function readPaidPushFacts(c: PublicClient, diamond: Hex, account: Hex, block?: bigint): Promise<PaidPushFacts> {
  const b = block ?? (await c.getBlockNumber({ cacheTime: 0 }));
  const [config, consent, posture] = await Promise.all([
    c.readContract({ address: diamond, abi: CONFIG, functionName: 'getNotificationFeeConfig', blockNumber: b }) as Promise<readonly [bigint, bigint]>,
    c.readContract({ address: diamond, abi: NOTIFICATION_FEE, functionName: 'getNotificationFeeConsent', args: [account], blockNumber: b }) as Promise<readonly [bigint, boolean]>,
    readSanctionsPosture(c, diamond, account, b),
  ]);
  return { fee: config[0], cap: consent[0], covers: consent[1], frozen: frozenState(posture) };
}

/** The card's read: the facts at one block, and the free vault VPFI beside
 *  them (its failure leaves the rest standing). */
export async function readPaidPush(c: PublicClient, diamond: Hex, account: Hex): Promise<PaidPushRead> {
  const [facts, freeVpfi] = await Promise.all([readPaidPushFacts(c, diamond, account), readFreeVpfi(c, diamond, account).catch(() => null)]);
  return { ...facts, freeVpfi, readAt: Date.now() };
}

/** Whether the alert service bills paid push on `chainId`: from its push
 *  status answer, or unknown when that answer could not be read. */
export type Billing = 'charges' | 'free' | 'unknown';

export function billingOn(push: PushStatus | null, chainId: number): Billing {
  if (push === null) return 'unknown';
  return push.billedChainIds.includes(chainId) ? 'charges' : 'free';
}

/** What the deployment offers: the consent record, or, without it, whether
 *  the bill is still routed (a fee may then be charged with no consent
 *  record to stop it). `checking` while the routing is not known yet. */
export type ConsentRouting = 'consent' | 'no-consent-bills' | 'no-consent-no-bill' | 'checking';

export function consentRouting(routed: ReadonlySet<string> | null, consentSelector: Hex, billSelector: Hex): ConsentRouting {
  if (routed === null) return 'checking';
  if (routed.has(consentSelector)) return 'consent';
  return routed.has(billSelector) ? 'no-consent-bills' : 'no-consent-no-bill';
}

/** The change a review stands for. */
export type ConsentChoice = { kind: 'agree'; cap: bigint } | { kind: 'withdraw' };

/** A cap typed by the reader: a plain decimal of VPFI, up to 18 places.
 *  Anything else is not read (null). */
export function parseCap(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d{1,3}(\.\d{1,18})?$/.test(s)) return null;
  return parseUnits(s, VPFI_DECIMALS);
}

export const vpfi = (v: bigint): string => formatUnits(v, VPFI_DECIMALS);

/** Why a choice cannot be sent, as a copy key, or null when it can. A
 *  withdrawal is refused only when nothing is stored: it stays offered
 *  whatever the Terms, a pause or the service say. A flagged wallet is not
 *  offered an agreement (ACC-16); a screen that cannot be read does not stop
 *  one, since agreeing moves nothing and the bill screens the payer itself,
 *  refusing while the screen cannot be read. */
export type ConsentProblem = 'nothing-stored' | 'not-billed' | 'billing-unknown' | 'flagged' | 'below-fee' | 'above-ceiling' | 'same-cap';

export function consentProblem(choice: ConsentChoice, facts: PaidPushFacts, billing: Billing): ConsentProblem | null {
  if (choice.kind === 'withdraw') return facts.cap === 0n ? 'nothing-stored' : null;
  if (billing === 'unknown') return 'billing-unknown';
  if (billing === 'free') return 'not-billed';
  if (facts.frozen === 'flagged') return 'flagged';
  if (choice.cap > CONSENT_CEILING) return 'above-ceiling';
  if (choice.cap < facts.fee) return 'below-fee';
  if (choice.cap === facts.cap) return 'same-cap';
  return null;
}

/** The call the review stands for. */
export function consentCall(choice: ConsentChoice) {
  return { abi: NOTIFICATION_FEE, functionName: 'setNotificationFeeConsent' as const, args: [choice.kind === 'agree' ? choice.cap : 0n] as const };
}

/** The review: the choice, the facts it stands on and the protocol's own dry
 *  run (null when it passes, its refusal, or 'unread'). */
export interface ConsentReview {
  identity: string;
  choice: ConsentChoice;
  facts: PaidPushFacts;
  freeVpfi: bigint | null;
  billing: Billing;
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

export async function readConsentReview(own: OwnStateClient, diamond: Hex, identity: string, choice: ConsentChoice, billing: Billing): Promise<ConsentReview> {
  const account = own.account;
  const { facts, freeVpfi } = await own
    .read(async (c: PublicClient) => {
      const [f, free] = await Promise.all([readPaidPushFacts(c, diamond, account), readFreeVpfi(c, diamond, account).catch(() => null)]);
      return { facts: f, freeVpfi: free };
    })
    .then((x) => x.value);
  let dryRun: ConsentReview['dryRun'] = null;
  if (consentProblem(choice, facts, billing) === null) {
    const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...consentCall(choice), account }));
    dryRun = dry.kind === 'reverted' ? refusalFromError(dry.error) : dry.kind === 'unreadable' ? 'unread' : null;
  }
  return { identity, choice, facts, freeVpfi, billing, dryRun, readAt: Date.now() };
}

/** What a re-read found changed, in words, or null. The fee is the figure
 *  that matters most: a fee that moved since the review is said before the
 *  wallet opens (RB-REVIEW). */
export function consentChanged(a: ConsentReview, b: ConsentReview, copy: Copy): string | null {
  if (a.facts.fee !== b.facts.fee) return copy.format('paidPush.changedFee', { before: vpfi(a.facts.fee), after: vpfi(b.facts.fee) });
  if (a.facts.cap !== b.facts.cap) return copy.format('paidPush.changedCap', { before: vpfi(a.facts.cap), after: vpfi(b.facts.cap) });
  if (a.facts.frozen !== b.facts.frozen) return copy.text('repay.changedVerdict');
  const code = (d: ConsentReview['dryRun']) => (d === null ? 'ok' : d === 'unread' ? 'unread' : d.code);
  if (code(a.dryRun) !== code(b.dryRun)) return copy.text('repay.changedVerdict');
  return null;
}

/** What stops the review, in words (empty when nothing does). */
export function consentBlockers(r: ConsentReview, copy: Copy): string[] {
  const problem = consentProblem(r.choice, r.facts, r.billing);
  if (problem !== null) return [copy.format(`paidPush.problem_${problem}` as CopyKey, { fee: vpfi(r.facts.fee), ceiling: vpfi(CONSENT_CEILING) })];
  if (r.dryRun === 'unread') return [copy.text('paidPush.dryRunUnread')];
  if (r.dryRun !== null && isFrozenRefusal(r.dryRun)) return [copy.text('paidPush.problem_flagged')];
  if (r.dryRun !== null) return [copy.format('repay.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

export function consentReceipt(r: ConsentReview, copy: Copy): Receipt {
  const { text, format } = copy;
  if (r.choice.kind === 'withdraw') {
    const rows: ReceiptRow[] = [
      { label: text('paidPush.rowCap'), value: { kind: 'text', text: format('paidPush.rowCapFromTo', { before: vpfi(r.facts.cap), after: '0' }) }, binding: true },
      { label: text('vault.rowMoves'), value: { kind: 'text', text: text('vault.rowMovesNothing') }, binding: true },
    ];
    return { title: text('paidPush.withdrawTitle'), rows, consequences: [text('paidPush.afterWithdraw'), text('paidPush.afterCharged')], prompts: 1, readAt: r.readAt };
  }
  const cap = r.choice.cap;
  const rows: ReceiptRow[] = [
    { label: text('paidPush.rowCap'), value: { kind: 'text', text: format('paidPush.rowCapValue', { cap: vpfi(cap) }) }, binding: true },
    { label: text('paidPush.rowFee'), value: { kind: 'text', text: format('paidPush.rowFeeValue', { fee: vpfi(r.facts.fee) }) }, binding: false },
    { label: text('paidPush.rowFrom'), value: { kind: 'text', text: text('paidPush.rowFromValue') }, binding: false },
    { label: text('vault.rowMoves'), value: { kind: 'text', text: text('paidPush.rowMovesNow') }, binding: true },
  ];
  const consequences: ReceiptText[] = [text('paidPush.afterOnce'), text('paidPush.afterRise'), text('paidPush.afterCharged'), text('paidPush.afterWithdrawAnytime')];
  if (cap === CONSENT_CEILING) consequences.unshift(format('paidPush.afterCeiling', { ceiling: vpfi(CONSENT_CEILING) }));
  if (r.freeVpfi !== null && r.freeVpfi < r.facts.fee) consequences.push(format('paidPush.afterLowVpfi', { free: vpfi(r.freeVpfi), fee: vpfi(r.facts.fee) }));
  return { title: text('paidPush.agreeTitle'), rows, consequences, prompts: 1, readAt: r.readAt };
}

/** The cap the transaction's record says it stored for `account`; null when
 *  it names none. */
export function storedCap(logs: readonly Log[], diamond: Hex, account: Hex): bigint | null {
  const events = parseEventLogs({ abi: NOTIFICATION_FEE, logs: logs as Log[], eventName: 'NotificationFeeConsentSet', strict: false });
  let cap: bigint | null = null;
  for (const e of events) {
    if (e.address.toLowerCase() !== diamond.toLowerCase()) continue;
    const args = e.args as { user?: Hex; cap?: bigint };
    if (args.user?.toLowerCase() === account.toLowerCase() && args.cap !== undefined) cap = args.cap;
  }
  return cap;
}

/** RB-CONFIDENCE — the finish card: the cap the record names. A mined write
 *  establishes the cap only; whether any fee is charged is the service's and
 *  the bill's business. */
export function measureConsent(logs: readonly Log[], diamond: Hex, account: Hex, choice: ConsentChoice, copy: Copy): LegOutcome[] {
  const cap = storedCap(logs, diamond, account);
  const label = copy.text(choice.kind === 'agree' ? 'paidPush.agreeTitle' : 'paidPush.withdrawTitle');
  if (cap === null) return [{ status: 'not-done', label, reason: copy.text('paidPush.notRecorded') }];
  if (cap === 0n) return [{ status: 'done', label: copy.text('paidPush.legWithdrawn') }];
  return [{ status: 'done', label: copy.format('paidPush.legAgreed', { cap: vpfi(cap) }) }];
}
