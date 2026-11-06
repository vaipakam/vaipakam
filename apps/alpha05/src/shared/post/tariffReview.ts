/**
 * OFF-22 — the Full fee tariff in a post's review, for either side: what
 * the protocol's reads say about the creator's opt-in before it is armed,
 * the receipt rows and consequences that state it, the blocker when no loan
 * could open, and the key a re-check compares.
 *
 * The opt-in is armed by its own transaction after posting, so nothing here
 * changes `createOffer`; the review states the gap before that transaction
 * confirms, during which a loan can open from the post without the tariff.
 * Each loan pays its own tariff when it opens, priced at that loan's
 * principal and checked against the creator's ceiling, so a range is read at
 * both ends: a request's smallest and largest amounts, or an offer's
 * smallest part and its whole amount (what a borrower taking it directly
 * borrows). The rules are the same for both sides (`resolveAndCharge`); what
 * the tariff buys differs: 10 more points of discount on a borrower's loan
 * fee, or on the protocol's share of a lender's interest for the loan's
 * term. Every figure is today's: the protocol re-prices and re-checks at
 * each loan's opening.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { AssetClass } from '../offers/assets';
import {
  FAILS_EVERY_LOAN,
  readFreeVpfi,
  readTariffQuote,
  readTariffSwitch,
  tariffIssues,
  VPFI_DECIMALS,
  type TariffChoice,
  type TariffIssue,
  type TariffQuote,
  type TariffRead,
} from '../offers/fullTariff';
import type { Receipt } from '../receipt/types';
import type { OwnStateClient } from '../../chain/ownRail';
import { formatUnits } from 'viem';
import { isRanged, type ParsedPost, type PostPair, type PostSide } from './postModel';
import { TARIFF_KEYS } from './postCopy';

type Hex = `0x${string}`;

/** The tariff's reads for a request that chose it, with why each failed one
 *  could not be read. */
export interface PostTariff {
  choice: TariffChoice;
  read: TariffRead;
  /** The read failures, by what failed, for the stated unknowns. */
  why: Partial<Record<'switch' | 'quote' | 'vault', string>>;
}

const reason = (e: unknown) => refusalFromError(e).reason;

/** Reads the switch, the tariff at the smallest and the largest loan, and
 *  the vault's free VPFI, through the wallet's connection. Liquidity is the
 *  lending asset's class the review already read. Null when the request did
 *  not choose the tariff. */
export async function readPostTariff(own: OwnStateClient, diamond: Hex, parsed: ParsedPost, pair: PostPair, lendingClass: AssetClass): Promise<PostTariff | null> {
  if (parsed.tariff === null) return null;
  const why: PostTariff['why'] = {};
  const read = <T>(fn: Parameters<OwnStateClient['read']>[0], what: keyof PostTariff['why']) =>
    own
      .read(fn)
      .then((x) => x.value as T)
      .catch((e: unknown) => {
        why[what] = reason(e);
        return null;
      });
  const quote = (amount: bigint) => read<TariffQuote>((c) => readTariffQuote(c, diamond, pair.lending, amount, parsed.durationDays), 'quote');
  const [enabled, smallest, largest, freeVpfi] = await Promise.all([
    read<boolean>((c) => readTariffSwitch(c, diamond), 'switch'),
    quote(parsed.amount),
    isRanged(parsed) ? quote(parsed.amountMax) : Promise.resolve<TariffQuote | null | undefined>(undefined),
    read<bigint>((c) => readFreeVpfi(c, diamond, own.account), 'vault'),
  ]);
  return {
    choice: parsed.tariff,
    read: { enabled, smallest, largest: largest === undefined ? smallest : largest, liquid: lendingClass === 'liquid', freeVpfi },
    why,
  };
}

/** The issues the protocol's reads raise against the opt-in. */
export function postTariffIssues(t: PostTariff): TariffIssue[] {
  return tariffIssues(t.choice, t.read);
}

/** Whether no loan could take the tariff now and none may open without it,
 *  so every loan the request opens would be refused: the review blocks. */
export function tariffRefusesEveryLoan(t: PostTariff | null): boolean {
  return t !== null && !t.choice.allowDowngrade && postTariffIssues(t).some((i) => FAILS_EVERY_LOAN.has(i.kind));
}

const vpfi = (v: bigint, format: CopyAccess['format']) => format('request.tariffVpfi', { amount: formatUnits(v, VPFI_DECIMALS) });

function quoteText(q: TariffQuote | null, why: string | undefined, copy: Pick<CopyAccess, 'text' | 'format'>, side: PostSide): string {
  if (q === null) return copy.format('request.tariffQuoteUnread', { reason: why ?? '' });
  if (!q.numeraireOk) return copy.text(TARIFF_KEYS[side].tariffUnpriced);
  return vpfi(q.cStar, copy.format);
}

/** The receipt rows. The ceiling and what a failed condition does are
 *  stored on the request once armed (bound); the switch, the tariff and the
 *  vault's free VPFI are today's reads (not bound). */
export function tariffRows(t: PostTariff | null, parsed: ParsedPost, copy: Pick<CopyAccess, 'text' | 'format'>, side: PostSide = 'borrower'): Receipt['rows'] {
  if (t === null) return [];
  const { text, format } = copy;
  const k = TARIFF_KEYS[side];
  const row = (label: CopyKey, value: string, binding: boolean) => ({ label: text(label), value: { kind: 'text' as const, text: value }, binding });
  const ranged = isRanged(parsed);
  return [
    row('request.rowTariff', text(k.tariffArmedAfter), true),
    row('request.rowTariffSwitch', text(t.read.enabled === null ? 'request.tariffSwitchUnknown' : t.read.enabled ? 'request.tariffSwitchOn' : 'request.tariffSwitchOff'), false),
    row(ranged ? 'request.rowTariffSmallest' : 'request.rowTariffQuote', quoteText(t.read.smallest, t.why.quote, copy, side), false),
    ...(ranged ? [row('request.rowTariffLargest', quoteText(t.read.largest, t.why.quote, copy, side), false)] : []),
    row('request.rowTariffCeiling', vpfi(t.choice.maxCStar, format), true),
    row('request.rowTariffFail', text(t.choice.allowDowngrade ? 'request.tariffFailOpen' : 'request.tariffFailRefuse'), true),
    row('request.rowTariffVault', t.read.freeVpfi === null ? format('request.tariffVaultUnread', { reason: t.why.vault ?? '' }) : vpfi(t.read.freeVpfi, format), false),
  ];
}

/** What the tariff adds to "You can lose", tier A and in Basic: what it
 *  costs and gives (a lender's discount lasts the loan's term and goes with
 *  the lender position), the gap before the arm confirms, and each issue the
 *  reads raise, stated as what happens to a loan under the chosen rule. */
export function tariffConsequences(t: PostTariff | null, copy: Pick<CopyAccess, 'text' | 'format'>, side: PostSide = 'borrower'): string[] {
  if (t === null) return [];
  const { text, format } = copy;
  const k = TARIFF_KEYS[side];
  const open = t.choice.allowDowngrade;
  const gives = side === 'lender' ? [text('lendOffer.loseTariffYield'), text('lendOffer.loseTariffHolder')] : [text('request.loseTariffLif')];
  const out = [text(k.loseTariffPaid), ...gives, text(k.loseTariffGap)];
  for (const i of postTariffIssues(t)) {
    switch (i.kind) {
      case 'off':
        out.push(text(open ? 'request.loseTariffOffOpen' : k.loseTariffOffRefuse));
        break;
      case 'unpriced':
        out.push(text(open ? 'request.loseTariffUnpricedOpen' : k.loseTariffUnpricedRefuse));
        break;
      case 'illiquid':
        out.push(text(open ? 'request.loseTariffIlliquidOpen' : k.loseTariffIlliquidRefuse));
        break;
      case 'ceiling-below-all':
        out.push(format(open ? 'request.loseTariffCeilingAllOpen' : k.loseTariffCeilingAllRefuse, { ceiling: vpfi(i.ceiling, format), tariff: vpfi(i.smallest, format) }));
        break;
      case 'ceiling-below-largest':
        out.push(format(open ? 'request.loseTariffCeilingSomeOpen' : 'request.loseTariffCeilingSomeRefuse', { ceiling: vpfi(i.ceiling, format), tariff: vpfi(i.largest, format) }));
        break;
      case 'vault-short': {
        // Short of even the smallest loan's tariff, every loan is affected
        // until VPFI is added; otherwise only the larger ones.
        const smallest = t.read.smallest?.cStar ?? null;
        const all = smallest !== null && i.free < smallest;
        const key = all ? (open ? 'request.loseTariffVaultAllOpen' : k.loseTariffVaultAllRefuse) : open ? 'request.loseTariffVaultOpen' : 'request.loseTariffVaultRefuse';
        out.push(format(key, { free: vpfi(i.free, format), needed: vpfi(all ? smallest : i.needed, format) }));
        break;
      }
      case 'unread':
        out.push(format('request.loseTariffUnread', { what: text(UNREAD_NAME[i.what]) }));
        break;
    }
  }
  return out;
}

const UNREAD_NAME: Readonly<Record<Extract<TariffIssue, { kind: 'unread' }>['what'], CopyKey>> = {
  switch: 'request.tariffUnreadSwitch',
  quote: 'request.tariffUnreadQuote',
  liquidity: 'request.tariffUnreadLiquidity',
  vault: 'request.tariffUnreadVault',
};

/** The blocker when every loan would be refused. */
export function tariffBlockers(t: PostTariff | null, copy: Pick<CopyAccess, 'text'>, side: PostSide = 'borrower'): string[] {
  return tariffRefusesEveryLoan(t) ? [copy.text(TARIFF_KEYS[side].blockTariffEvery)] : [];
}

/** What the tariff's reads stand on, for the "what changed" of a re-check. */
export function tariffKey(t: PostTariff | null): string {
  if (t === null) return '-';
  const q = (x: TariffQuote | null) => (x === null ? '-' : `${x.cStar}:${x.numeraireOk}`);
  return [String(t.read.enabled), q(t.read.smallest), q(t.read.largest), String(t.read.liquid), String(t.read.freeVpfi)].join('|');
}
