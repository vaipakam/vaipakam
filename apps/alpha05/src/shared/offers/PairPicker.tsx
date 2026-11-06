import { useId, useState } from 'react';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { parsePasted, readAssetClass, suggestedAssets, suggestedCollateral } from './assets';
import { useAssetStandard } from '../nft/useStandard';
import { useChainRead } from '../reads/chainRead';
import { assetName, type TokenMetaMap } from '../reads/tokens';
import { FormField } from '../ui/FormField';
import { Notice } from '../ui/Notice';

type Hex = `0x${string}`;

const OTHER = 'other';

/** One leg of the pair: a suggested token, or a pasted address. */
function AssetChoice({
  label,
  value,
  chain,
  meta,
  onChange,
  testId,
  leg,
}: {
  label: string;
  value: Hex | null;
  chain: SupportedChain;
  meta: TokenMetaMap | null;
  onChange: (asset: Hex | null) => void;
  testId: string;
  /** The collateral leg also offers the test NFT collections (NFT-13). */
  leg: 'lending' | 'collateral';
}) {
  const { text, format } = useCopy();
  const id = useId();
  const suggested = leg === 'collateral' ? suggestedCollateral(chain) : suggestedAssets(chain).map((c) => ({ ...c, nft: false }));
  const isSuggested = value !== null && suggested.some((c) => c.address.toLowerCase() === value.toLowerCase());
  const [other, setOther] = useState(value !== null && !isSuggested);
  const [pasted, setPasted] = useState(value !== null && !isSuggested ? value : '');
  const invalid = other && pasted.trim() !== '' && parsePasted(pasted) === null;

  return (
    <div className="asset-choice" data-testid={testId}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={other ? OTHER : (value ?? '')}
        onChange={(e) => {
          const v = e.target.value;
          if (v === OTHER) {
            setOther(true);
            onChange(parsePasted(pasted));
          } else {
            setOther(false);
            onChange(v === '' ? null : (v as Hex));
          }
        }}
      >
        <option value="">{text('borrow.pickChoose')}</option>
        {suggested.map((c) => (
          <option key={c.address} value={c.address}>
            {assetName(c.address, meta)}
            {c.nft ? ` (${text('borrow.testNftBadge')})` : c.test ? ` (${text('borrow.testBadge')})` : ''}
          </option>
        ))}
        <option value={OTHER}>{text('borrow.pickOther')}</option>
      </select>
      {other && (
        <FormField label={text('borrow.pasteLabel')} error={invalid ? text('borrow.pasteInvalid') : null} hint={text('borrow.noScreening')}>
          {({ id: inputId, describedBy, invalid: bad }) => (
            <input
              id={inputId}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={pasted}
              aria-describedby={describedBy}
              aria-invalid={bad}
              onChange={(e) => {
                setPasted(e.target.value);
                onChange(parsePasted(e.target.value));
              }}
            />
          )}
        </FormField>
      )}
      {suggested.length === 0 && <p className="tier-b">{text('borrow.pickNone')}</p>}
      {value !== null && <AssetStandardLine asset={value} meta={meta} leg={leg} />}
      {value !== null && <AssetClassLine asset={value} chain={chain} meta={meta} />}
      {value === null && !other && suggested.length > 0 && <p className="tier-b">{format('borrow.pickHint', { chain: chain.name })}</p>}
    </div>
  );
}

/** NFT-13 — the standard the asset's contract claims, said only when it is
 *  an NFT (an ERC-20 needs no line) or could not be read. */
function AssetStandardLine({ asset, meta, leg }: { asset: Hex; meta: TokenMetaMap | null; leg: 'lending' | 'collateral' }) {
  const { format } = useCopy();
  const std = useAssetStandard(asset);
  const name = assetName(asset, meta);
  if (std.state === 'reading' || std.data === 'erc20') return null;
  if (std.state === 'failed' || std.data === null)
    return (
      <Notice tone="warn" tier="A">
        {format('borrow.standardFailed', { asset: name, reason: std.error ?? 'no answer' })}
      </Notice>
    );
  if (leg === 'lending')
    return (
      <Notice tone="warn" tier="A">
        {format('borrow.lendingNft', { asset: name })}
      </Notice>
    );
  return (
    <div data-asset-standard={std.data}>
      <WhyLink summaryKey={std.data === 'erc721' ? 'borrow.nft721' : 'borrow.nft1155'} detailKey="borrow.nftWhy" vars={{ asset: name }} />
    </div>
  );
}

/** OFF-03 — what the protocol says about the asset now, read live. */
function AssetClassLine({ asset, chain, meta }: { asset: Hex; chain: SupportedChain; meta: TokenMetaMap | null }) {
  const { format } = useCopy();
  const cls = useChainRead(['assetClass', chain.diamondAddress, asset.toLowerCase()], (c) => readAssetClass(c, chain.diamondAddress, asset));
  const name = assetName(asset, meta);
  if (cls.state === 'reading') return <p className="tier-b">{format('borrow.classReading', { asset: name })}</p>;
  if (cls.state === 'failed' || cls.data === null)
    return (
      <Notice tone="warn" tier="A">
        {format('borrow.classFailed', {
          asset: name,
          reason: cls.error ?? 'no answer',
        })}
      </Notice>
    );
  const vars = { asset: name, chain: chain.name };
  if (cls.data === 'distrusted')
    return (
      <Notice tone="danger" tier="A">
        {format('borrow.classDistrusted', vars)}
      </Notice>
    );
  return (
    <div data-asset-class={cls.data}>
      <WhyLink summaryKey={cls.data === 'liquid' ? 'borrow.classLiquid' : 'borrow.classIlliquid'} detailKey="borrow.classWhy" vars={vars} />
    </div>
  );
}

/** OFF-02 — the pair a borrower picks: what to borrow, what to lock. */
export function PairPicker({
  chain,
  meta,
  lending,
  collateral,
  onChange,
}: {
  chain: SupportedChain;
  meta: TokenMetaMap | null;
  lending: Hex | null;
  collateral: Hex | null;
  onChange: (pair: { lending: Hex | null; collateral: Hex | null }) => void;
}) {
  const { text } = useCopy();
  const same = lending !== null && collateral !== null && lending.toLowerCase() === collateral.toLowerCase();
  return (
    <section className="borrow-section pair-picker" aria-labelledby="borrow-pair">
      <h2 id="borrow-pair" className="sr-only">
        {text('borrow.stepPair')}
      </h2>
      <div className="pair-grid">
        <AssetChoice
          label={text('borrow.pickLending')}
          value={lending}
          chain={chain}
          meta={meta}
          onChange={(a) => onChange({ lending: a, collateral })}
          testId="pick-lending"
          leg="lending"
        />
        <AssetChoice
          label={text('borrow.pickCollateral')}
          value={collateral}
          chain={chain}
          meta={meta}
          onChange={(a) => onChange({ lending, collateral: a })}
          testId="pick-collateral"
          leg="collateral"
        />
      </div>
      {same && (
        <Notice tone="danger" tier="A">
          {text('borrow.sameAsset')}
        </Notice>
      )}
    </section>
  );
}
