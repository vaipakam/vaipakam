import { useState } from 'react';
import { useCopy } from '../copy/useCopy';
import { readText, textCut, type Receipt as ReceiptModel, type ReceiptValue } from '../receipt/types';
import { formatAge, formatFigure, formatUnits, shortAddress } from './format';
import { Icon } from './Icon';

/** What a surface knows about an asset; `null` when it has not identified it. */
export interface AssetInfo {
  symbol: string;
  decimals: number;
}

export interface ReceiptProps {
  receipt: ReceiptModel;
  describeAsset: (asset: `0x${string}`) => AssetInfo | null;
  /** The clock the age of the read is measured against (unix ms). */
  nowMs: number;
}

/** A value rendered as the receipt states it: a figure only where the
 *  asset is identified (RB-FUNDS: never a figure the surface cannot
 *  substantiate), and an unknown as an unknown with its reason. An amount
 *  is shown short (`formatFigure`, marked "≈" when digits were dropped)
 *  unless `exact` asks for every digit; `cut` says the two differ. */
export function renderValue(
  value: ReceiptValue,
  describeAsset: ReceiptProps['describeAsset'],
  unknownWord: string,
  exact = false,
): { text: string; unknown: boolean; cut: boolean; full: string | null } {
  switch (value.kind) {
    case 'amount': {
      const asset = describeAsset(value.asset);
      if (!asset) return { text: `${unknownWord}: asset ${shortAddress(value.asset)} not identified`, unknown: true, cut: false, full: null };
      const full = `${formatUnits(value.amount, asset.decimals)} ${asset.symbol}`;
      const f = formatFigure(value.amount, asset.decimals);
      const short = `${f.cut ? '≈ ' : ''}${f.text} ${asset.symbol}`;
      return { text: exact ? full : short, unknown: false, cut: f.cut, full };
    }
    case 'text':
      // A text that embeds a shortened figure carries its exact version.
      if (value.exact === undefined || value.exact === value.text) return { text: value.text, unknown: false, cut: false, full: null };
      return { text: exact ? value.exact : value.text, unknown: false, cut: true, full: value.exact };
    case 'time':
      return { text: new Date(value.unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC', unknown: false, cut: false, full: null };
    case 'unknown':
      return { text: `${unknownWord}: ${value.why}`, unknown: true, cut: false, full: null };
  }
}

/**
 * RB-CONFIDENCE — the receipt shown before signing: every row the protocol
 * will act on, the binding rows marked, every consequence stated, the
 * number of wallet prompts, and when its inputs were last read.
 */
export function Receipt({ receipt, describeAsset, nowMs }: ReceiptProps) {
  const { text, format } = useCopy();
  const unknownWord = text('receipt.unknown');
  const [exact, setExact] = useState(false);
  const values = receipt.rows.map((row) => renderValue(row.value, describeAsset, unknownWord, exact));
  const anyCut = values.some((v) => v.cut) || receipt.consequences.some(textCut);
  return (
    <section className="receipt" aria-label={receipt.title}>
      <h2>{receipt.title}</h2>
      <dl className="facts">
        {receipt.rows.map((row, i) => {
          const v = values[i]!;
          return [
            <dt key={`${row.label}-t`} className={row.binding ? 'tier-a' : 'tier-b'} data-moves-out={row.movesOut ? 'true' : undefined}>
              {row.movesOut && <Icon meaning="money-out" size={16} />}
              {row.label}
            </dt>,
            <dd
              key={`${row.label}-d`}
              className={[v.unknown ? 'value-unknown' : '', row.value.kind === 'amount' ? 'value-amount' : ''].filter(Boolean).join(' ') || undefined}
              data-binding={row.binding ? 'true' : undefined}
              title={v.cut && !exact ? (v.full ?? undefined) : undefined}
            >
              {v.unknown && <Icon meaning="unknown" size={16} />}
              {v.text}
            </dd>,
          ];
        })}
      </dl>
      {anyCut && (
        <button type="button" className="btn btn-link receipt-exact" aria-pressed={exact} onClick={() => setExact((x) => !x)} data-testid="receipt-exact">
          {text(exact ? 'receipt.showShort' : 'receipt.showExact')}
        </button>
      )}
      {receipt.consequences.length > 0 && (
        <ul className="consequences tier-a" aria-label={text('receipt.consequences')}>
          {receipt.consequences.map((c) => {
            const line = readText(c, exact);
            return (
              <li key={readText(c, false)} title={textCut(c) && !exact ? readText(c, true) : undefined}>
                {line}
              </li>
            );
          })}
        </ul>
      )}
      <p className="tier-b">
        {receipt.afterPrompts
          ? format('receipt.promptsThen', { count: String(receipt.prompts), after: String(receipt.afterPrompts) })
          : format('receipt.prompts', { count: String(receipt.prompts) })}{' '}
        {format('receipt.readAt', { age: formatAge((nowMs - receipt.readAt) / 1000) })}
      </p>
    </section>
  );
}
