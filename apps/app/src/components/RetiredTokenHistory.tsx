/**
 * #3021 — the history panel under the NFT verifier's RETIRED verdict: what
 * the public indexer recorded for the token (its offer or loan, side, final
 * status, terms, and the retirement).
 *
 * Renders NOTHING unless the indexer answers with a record for this exact
 * chain and token: the verdict above is chain-sourced and complete without
 * it, so a missing index is silence, not an error. Every term the index
 * cannot confirm says so ("Not confirmed by the index") instead of showing
 * a figure, and the retirement reason is shown only when the index's record
 * supports one.
 */
import { useQuery } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useTokenMeta } from '../contracts/erc20';
import { fetchPositionHistory, type PositionHistory } from '../data/positionHistory';
import { AssetType } from '../lib/types';
import {
  formatBpsAsPercent,
  formatDateTime,
  formatDurationDays,
  formatTokenAmount,
  shortAddress,
} from '../lib/format';

interface Props {
  tokenId: string;
}

/** One amount of one asset, in the words the asset's kind allows. */
function useAmountText(
  asset: string,
  assetType: number,
): (raw: string, nftId: string | null) => string {
  const meta = useTokenMeta(assetType === AssetType.ERC20 ? asset : undefined);
  const h = copy.nftVerifier.history;
  return (raw, nftId) => {
    if (assetType === AssetType.ERC20) {
      if (meta.data) return `${formatTokenAmount(raw, meta.data.decimals)} ${meta.data.symbol}`;
      if (meta.isError) return h.tokenUnits(raw, shortAddress(asset));
      return '…';
    }
    const collection = shortAddress(asset);
    if (nftId === null) return h.nftCollection(collection);
    return assetType === AssetType.ERC1155
      ? h.nftQuantity(raw, collection, nftId)
      : h.nftItem(nftId, collection);
  };
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="receipt-row">
      <dt>{label}</dt>
      <dd className={muted ? 'muted' : undefined}>{value}</dd>
    </div>
  );
}

function HistoryRows({ history }: { history: PositionHistory }) {
  const { readChain } = useActiveChain();
  const h = copy.nftVerifier.history;
  const { record, retirement, reason } = history;
  const lent = useAmountText(record.lendingAsset, record.assetType);
  const collateral = useAmountText(record.collateralAsset, record.collateralAssetType);
  const statusText =
    (record.kind === 'loan' ? h.loanStatus : h.offerStatus)[record.status] ?? h.statusOther;
  const lentIsToken = record.assetType === AssetType.ERC20;

  return (
    <dl className="receipt" style={{ margin: 0 }}>
      {record.kind === 'loan' ? (
        <Row label={h.loanLabel} value={`#${record.loanId}`} />
      ) : (
        <Row label={h.offerLabel} value={`#${record.offerId}`} />
      )}
      <Row label={h.sideLabel} value={record.side === 'lender' ? h.sideLender : h.sideBorrower} />
      <Row label={h.statusLabel} value={statusText} />
      {record.kind === 'loan' ? (
        <>
          {lentIsToken ? (
            record.agreed.principal === null ? (
              <Row label={h.principalLabel} value={h.notConfirmed} muted />
            ) : (
              <Row label={h.principalLabel} value={lent(record.agreed.principal, null)} />
            )
          ) : (
            <Row
              label={h.rentedLabel}
              value={h.nftItem(record.lentTokenId, shortAddress(record.lendingAsset))}
            />
          )}
          <Row
            label={h.rateLabel}
            value={
              record.agreed.interestRateBps === null
                ? h.notConfirmed
                : formatBpsAsPercent(record.agreed.interestRateBps)
            }
            muted={record.agreed.interestRateBps === null}
          />
          <Row
            label={h.durationLabel}
            value={
              record.agreed.durationDays === null
                ? h.notConfirmed
                : formatDurationDays(record.agreed.durationDays)
            }
            muted={record.agreed.durationDays === null}
          />
          <Row
            label={h.collateralLabel}
            value={collateral(record.lastCollateralAmount, record.collateralTokenId)}
          />
          {record.closedAt !== null ? (
            <Row label={h.closedLabel} value={formatDateTime(record.closedAt)} />
          ) : null}
        </>
      ) : (
        <>
          {lentIsToken ? (
            <Row
              label={h.offerAmountLabel}
              value={
                record.amountMax === null
                  ? lent(record.amount, null)
                  : h.range(lent(record.amount, null), lent(record.amountMax, null))
              }
            />
          ) : (
            <Row label={h.rentedLabel} value={h.nftCollection(shortAddress(record.lendingAsset))} />
          )}
          <Row
            label={h.offerRateLabel}
            value={
              record.interestRateBpsMax === null
                ? formatBpsAsPercent(record.interestRateBps)
                : h.range(
                    formatBpsAsPercent(record.interestRateBps),
                    formatBpsAsPercent(record.interestRateBpsMax),
                  )
            }
          />
          <Row label={h.offerDurationLabel} value={formatDurationDays(record.durationDays)} />
          <Row label={h.offerCollateralLabel} value={collateral(record.collateralAmount, null)} />
        </>
      )}
      {retirement ? (
        <div className="receipt-row">
          <dt>{h.retiredLabel}</dt>
          <dd>
            {h.retiredValue(formatDateTime(retirement.at), String(retirement.blockNumber))}{' '}
            <a
              href={`${readChain.blockExplorer}/tx/${retirement.txHash}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {h.retiredTx}
            </a>
          </dd>
        </div>
      ) : null}
      {reason ? (
        <Row
          label={h.reasonLabel}
          value={
            reason === 'position-moved'
              ? h.reasonPositionMoved
              : reason === 'loan-closed'
                ? h.reasonLoanClosed
                : h.reasonOfferCancelled
          }
        />
      ) : null}
    </dl>
  );
}

export function RetiredTokenHistory({ tokenId }: Props) {
  const { readChain } = useActiveChain();
  const history = useQuery({
    queryKey: ['positionHistory', readChain.chainId, tokenId],
    staleTime: 60_000,
    retry: 1,
    queryFn: () => fetchPositionHistory(readChain.chainId, tokenId),
  });
  if (!history.data) return null;
  return (
    <div data-testid="nft-retired-history" style={{ marginTop: 12 }}>
      <h4 style={{ margin: '0 0 4px' }}>{copy.nftVerifier.history.title}</h4>
      <p className="muted" style={{ marginTop: 0 }}>
        {copy.nftVerifier.history.source}
      </p>
      <HistoryRows history={history.data} />
    </div>
  );
}
