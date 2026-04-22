import { BigInt, Bytes, log } from '@graphprotocol/graph-ts';
import {
  LoanInitiated as LoanInitiatedEvent,
  LoanRepaid as LoanRepaidEvent,
  LoanDefaulted as LoanDefaultedEvent,
  LoanLiquidated as LoanLiquidatedEvent,
  LiquidationFallback as LiquidationFallbackEvent,
} from '../generated/Diamond/Diamond';
import { Loan, LoanTransition, DriftStats } from '../generated/schema';

const DRIFT_STATS_ID = 'global';

// Enum-string values must match schema.graphql LoanStatus.
const STATUS_UNKNOWN = 'Unknown';
const STATUS_ACTIVE = 'Active';
const STATUS_REPAID = 'Repaid';
const STATUS_DEFAULTED = 'Defaulted';
const STATUS_FALLBACK = 'FallbackPending';
const STATUS_LIQUIDATED = 'Liquidated';

function loadOrCreateStats(): DriftStats {
  let stats = DriftStats.load(DRIFT_STATS_ID);
  if (stats == null) {
    stats = new DriftStats(DRIFT_STATS_ID);
    stats.invalidTransitions = 0;
  }
  return stats;
}

/**
 * Protocol state machine. Any transition NOT listed here is a bug — either
 * in the contract or in the indexer's understanding of the contract.
 * Keeping this table explicit (vs. an allow-all) is the whole point of
 * this subgraph.
 */
function isValidTransition(from: string, to: string): boolean {
  if (from == STATUS_UNKNOWN) return to == STATUS_ACTIVE;
  if (from == STATUS_ACTIVE) {
    return (
      to == STATUS_REPAID ||
      to == STATUS_DEFAULTED ||
      to == STATUS_FALLBACK ||
      to == STATUS_LIQUIDATED
    );
  }
  if (from == STATUS_FALLBACK) {
    return to == STATUS_REPAID || to == STATUS_DEFAULTED || to == STATUS_LIQUIDATED;
  }
  // Repaid / Defaulted / Liquidated are terminal.
  return false;
}

function writeTransition(
  loan: Loan,
  nextStatus: string,
  txHash: Bytes,
  logIndex: BigInt,
  block: BigInt,
  timestamp: BigInt,
): void {
  const id = txHash.toHex() + '-' + logIndex.toString();
  const t = new LoanTransition(id);
  t.loan = loan.id;
  t.fromStatus = loan.currentStatus;
  t.toStatus = nextStatus;
  t.block = block;
  t.timestamp = timestamp;
  t.txHash = txHash;

  if (!isValidTransition(loan.currentStatus, nextStatus)) {
    t.invalidReason = loan.currentStatus + ' → ' + nextStatus + ' is not a valid protocol transition';
    const stats = loadOrCreateStats();
    stats.invalidTransitions = stats.invalidTransitions + 1;
    stats.lastInvalidTxHash = txHash;
    stats.lastInvalidTimestamp = timestamp;
    stats.save();
    log.warning('[drift] invalid transition on loan {}: {} → {}', [
      loan.loanId.toString(),
      loan.currentStatus,
      nextStatus,
    ]);
  }

  t.save();

  loan.currentStatus = nextStatus;
  loan.updatedAtBlock = block;
  loan.updatedAtTimestamp = timestamp;
  loan.save();
}

export function handleLoanInitiated(event: LoanInitiatedEvent): void {
  const id = event.params.loanId.toString();
  let loan = Loan.load(id);
  if (loan == null) {
    loan = new Loan(id);
    loan.loanId = event.params.loanId;
    loan.borrower = event.params.borrower;
    loan.lender = event.params.lender;
    loan.offerId = event.params.offerId;
    loan.currentStatus = STATUS_UNKNOWN;
    loan.createdAtBlock = event.block.number;
    loan.createdAtTimestamp = event.block.timestamp;
    loan.updatedAtBlock = event.block.number;
    loan.updatedAtTimestamp = event.block.timestamp;
    loan.defaultedCount = 0;
    loan.repaidCount = 0;
    loan.liquidatedCount = 0;
    loan.fallbackCount = 0;
  }
  writeTransition(loan, STATUS_ACTIVE, event.transaction.hash, event.logIndex, event.block.number, event.block.timestamp);
}

export function handleLoanRepaid(event: LoanRepaidEvent): void {
  const id = event.params.loanId.toString();
  const loan = Loan.load(id);
  if (loan == null) {
    log.warning('[drift] repay for unknown loan {}', [id]);
    return;
  }
  loan.repaidCount = loan.repaidCount + 1;
  writeTransition(loan, STATUS_REPAID, event.transaction.hash, event.logIndex, event.block.number, event.block.timestamp);
}

export function handleLoanDefaulted(event: LoanDefaultedEvent): void {
  const id = event.params.loanId.toString();
  const loan = Loan.load(id);
  if (loan == null) return;
  loan.defaultedCount = loan.defaultedCount + 1;
  writeTransition(loan, STATUS_DEFAULTED, event.transaction.hash, event.logIndex, event.block.number, event.block.timestamp);
}

export function handleLoanLiquidated(event: LoanLiquidatedEvent): void {
  const id = event.params.loanId.toString();
  const loan = Loan.load(id);
  if (loan == null) return;
  loan.liquidatedCount = loan.liquidatedCount + 1;
  writeTransition(loan, STATUS_LIQUIDATED, event.transaction.hash, event.logIndex, event.block.number, event.block.timestamp);
}

export function handleLiquidationFallback(event: LiquidationFallbackEvent): void {
  const id = event.params.loanId.toString();
  const loan = Loan.load(id);
  if (loan == null) return;
  loan.fallbackCount = loan.fallbackCount + 1;
  writeTransition(loan, STATUS_FALLBACK, event.transaction.hash, event.logIndex, event.block.number, event.block.timestamp);
}
