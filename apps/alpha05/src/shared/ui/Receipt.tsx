import { useCopy } from '../copy/useCopy';
import type { Receipt as ReceiptModel, ReceiptValue } from '../receipt/types';
import { formatAge, formatUnits, shortAddress } from './format';
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
 *  substantiate), and an unknown as an unknown with its reason. */
export function renderValue(value: ReceiptValue, describeAsset: ReceiptProps['describeAsset'], unknownWord: string): { text: string; unknown: boolean } {
  switch (value.kind) {
    case 'amount': {
      const asset = describeAsset(value.asset);
      if (!asset) return { text: `${unknownWord}: asset ${shortAddress(value.asset)} not identified`, unknown: true };
      return { text: `${formatUnits(value.amount, asset.decimals)} ${asset.symbol}`, unknown: false };
    }
    case 'text':
      return { text: value.text, unknown: false };
    case 'time':
      return { text: new Date(value.unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC', unknown: false };
    case 'unknown':
      return { text: `${unknownWord}: ${value.why}`, unknown: true };
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
  return (
    <section className="receipt" aria-label={receipt.title}>
      <h2>{receipt.title}</h2>
      <dl className="facts">
        {receipt.rows.map((row) => {
          const v = renderValue(row.value, describeAsset, unknownWord);
          return [
            <dt key={`${row.label}-t`} className={row.binding ? 'tier-a' : 'tier-b'} data-moves-out={row.movesOut ? 'true' : undefined}>
              {row.movesOut && <Icon meaning="money-out" size={16} />}
              {row.label}
            </dt>,
            <dd key={`${row.label}-d`} className={v.unknown ? 'value-unknown' : undefined} data-binding={row.binding ? 'true' : undefined}>
              {v.unknown && <Icon meaning="unknown" size={16} />}
              {v.text}
            </dd>,
          ];
        })}
      </dl>
      {receipt.consequences.length > 0 && (
        <ul className="consequences tier-a" aria-label={text('receipt.consequences')}>
          {receipt.consequences.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      <p className="tier-b">
        {format('receipt.prompts', { count: String(receipt.prompts) })} {format('receipt.readAt', { age: formatAge((nowMs - receipt.readAt) / 1000) })}
      </p>
    </section>
  );
}
