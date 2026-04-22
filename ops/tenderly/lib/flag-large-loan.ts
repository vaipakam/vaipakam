import { ActionFn, Context, TransactionEvent } from '@tenderly/actions';
import { ethers } from 'ethers';

/**
 * Event-triggered action: on every LoanInitiated, fetch the loan's USD
 * notional and compare against the rolling p99 stored in action storage.
 * Slack-only — large loans are intended behaviour, but we want a human
 * eyeball so an economic-attack (e.g. manipulating oracle via one outsized
 * loan) doesn't sit unseen until it plays out.
 *
 * The p99 baseline is recomputed offline (monthly job) from the subgraph
 * and written to storage under `loan_size_p99_usd`.
 */
const DIAMOND_ABI = [
  'function getLoanDetails(uint256 loanId) view returns (tuple(uint256 id, address borrower, address lender, uint256 offerId, uint256 principal, address principalAsset, uint8 assetType, uint256 collateralAmount, address collateralAsset, uint8 collateralAssetType, uint16 interestRateBps, uint32 durationDays, uint64 startTime, uint8 status) loan)',
  'function getAssetPrice(address asset) view returns (uint256 price, uint8 decimals)',
];

export const flagLargeLoan: ActionFn = async (context: Context, event: TransactionEvent) => {
  const diamond = await context.secrets.get('DIAMOND_ADDRESS');
  const rpcUrl = await context.secrets.get('RPC_URL');
  const p99Str = (await context.storage.getStr('loan_size_p99_usd')) || '0';
  const p99 = Number(p99Str);
  if (p99 === 0) return;

  const iface = new ethers.Interface([
    'event LoanInitiated(uint256 indexed loanId, uint256 indexed offerId, address indexed lender, address borrower)',
  ]);
  const log = event.logs.find((l) => {
    try { iface.parseLog({ topics: l.topics, data: l.data }); return true; } catch { return false; }
  });
  if (!log) return;
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  const loanId: bigint = parsed!.args[0];

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(diamond, DIAMOND_ABI, provider);
  const details = await contract.getLoanDetails(loanId);
  const price = await contract.getAssetPrice(details.principalAsset);

  const principalFloat = Number(details.principal) / 10 ** 18; // assume 18d; refine per-asset as needed
  const usd = principalFloat * (Number(price.price) / 10 ** Number(price.decimals));

  if (usd > p99) {
    throw new Error(`Loan ${loanId} principal $${usd.toFixed(0)} > p99 $${p99}`);
  }
};
