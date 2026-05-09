import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ShieldAlert, CheckCircle2, Lock } from 'lucide-react';
import {
  parseAbi,
  parseUnits,
  isAddress,
  decodeEventLog,
  type Address,
  type Hex,
} from 'viem';
import { useWallet } from '../context/WalletContext';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { useWalletClient } from 'wagmi';
import { DEFAULT_CHAIN } from '../contracts/config';

/**
 * T-054 PR-4 — Stuck-token recovery page.
 *
 * INTENTIONALLY HIDDEN from the main app navigation. Reachable only
 * via a deep link from the Advanced User Guide section on stuck-
 * token recovery, with `<meta name="robots" content="noindex,nofollow">`
 * applied below. The discoverability gating is part of the security
 * design: a user dust-poisoned by a third party should NOT trip the
 * sanctions ban by accidentally clicking "recover" on dust they
 * didn't send. By the time someone arrives here they've read the
 * Advanced User Guide explainer.
 *
 * Flow:
 *   1. User enters token address + declared source + amount.
 *   2. Click Review → modal shows declared values + warning.
 *   3. Type "CONFIRM" → enables Sign button.
 *   4. Sign EIP-712 acknowledgment via wallet.
 *   5. Submit tx; wait for receipt; parse outcome from event log:
 *        StuckERC20Recovered → success path
 *        EscrowBannedFromRecoveryAttempt → ban-as-outcome path
 *
 * The on-chain function `recoverStuckERC20` does NOT revert on the
 * sanctioned-source path — it returns successfully so the ban-state
 * writes persist. The frontend must distinguish outcomes by
 * inspecting which event was emitted.
 */

// Minimal contract surface this page consumes.
const RECOVERY_ABI = parseAbi([
  'function recoverStuckERC20(address token, address declaredSource, uint256 amount, uint256 deadline, bytes signature)',
  'function recoveryDomainSeparator() view returns (bytes32)',
  'function recoveryAckTextHash() view returns (bytes32)',
  'function recoveryNonce(address user) view returns (uint256)',
  'function getProtocolTrackedEscrowBalance(address user, address token) view returns (uint256)',
  'function getUserEscrowAddress(address user) view returns (address)',
  'event StuckERC20Recovered(address indexed user, address indexed token, address indexed declaredSource, uint256 amount, uint256 nonce)',
  'event EscrowBannedFromRecoveryAttempt(address indexed user, address indexed token, address indexed declaredSource, uint256 amount)',
]);

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

// EIP-712 typed-data shape — must match the on-chain RECOVERY_TYPEHASH
// in EscrowFactoryFacet exactly, OR the recovered signer won't equal
// msg.sender and the contract reverts RecoverySignatureInvalid.
const RECOVERY_TYPES = {
  RecoveryAcknowledgment: [
    { name: 'user', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'declaredSource', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'ackTextHash', type: 'bytes32' },
  ],
} as const;

type Status =
  | { kind: 'idle' }
  | { kind: 'reviewing' }
  | { kind: 'signing' }
  | { kind: 'submitting'; txHash?: Hex }
  | { kind: 'success'; txHash: Hex; amount: bigint; symbol: string }
  | { kind: 'banned'; txHash: Hex; declaredSource: Address }
  | { kind: 'error'; message: string };

const RECOVERY_DEADLINE_SECONDS = 30 * 60; // 30 min

export default function EscrowRecover() {
  const { t } = useTranslation();
  const { address, chainId, isCorrectChain } = useWallet();
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const { data: walletClient } = useWalletClient();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;

  // Inject `noindex,nofollow` for the lifetime of this page so search
  // engines don't surface it. Removed on unmount.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex,nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  // Form state
  const [tokenInput, setTokenInput] = useState('');
  const [sourceInput, setSourceInput] = useState('');
  const [amountInput, setAmountInput] = useState('');

  // Live token meta — read once per token-input change.
  const [tokenSymbol, setTokenSymbol] = useState<string>('');
  const [tokenDecimals, setTokenDecimals] = useState<number>(18);
  const [unsolicited, setUnsolicited] = useState<bigint | null>(null);
  const [tokenLookupErr, setTokenLookupErr] = useState<string | null>(null);

  // Review modal state
  const [confirmInput, setConfirmInput] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const inFlightRef = useRef(false);

  const validToken = isAddress(tokenInput);
  const validSource = isAddress(sourceInput);
  const amountValid = useMemo(() => {
    if (!amountInput) return false;
    try {
      const v = parseUnits(amountInput, tokenDecimals);
      return v > 0n;
    } catch {
      return false;
    }
  }, [amountInput, tokenDecimals]);

  // Token meta + unsolicited-cap probe whenever the token input
  // resolves to a valid address. Drives the "max recoverable" hint
  // shown next to the amount field.
  useEffect(() => {
    if (!validToken || !address) {
      setTokenSymbol('');
      setTokenDecimals(18);
      setUnsolicited(null);
      setTokenLookupErr(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [sym, dec] = await Promise.all([
          publicClient.readContract({
            address: tokenInput as Address,
            abi: ERC20_BALANCE_ABI,
            functionName: 'symbol',
          }) as Promise<string>,
          publicClient.readContract({
            address: tokenInput as Address,
            abi: ERC20_BALANCE_ABI,
            functionName: 'decimals',
          }) as Promise<number>,
        ]);
        if (cancelled) return;
        setTokenSymbol(sym);
        setTokenDecimals(Number(dec));

        // Compute unsolicited = max(0, balanceOf(escrow) - tracked).
        const escrow = (await publicClient.readContract({
          address: diamondAddress,
          abi: RECOVERY_ABI,
          functionName: 'getUserEscrowAddress',
          args: [address as Address],
        })) as Address;
        if (escrow === '0x0000000000000000000000000000000000000000') {
          setUnsolicited(0n);
          return;
        }
        const [bal, tracked] = await Promise.all([
          publicClient.readContract({
            address: tokenInput as Address,
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [escrow],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: diamondAddress,
            abi: RECOVERY_ABI,
            functionName: 'getProtocolTrackedEscrowBalance',
            args: [address as Address, tokenInput as Address],
          }) as Promise<bigint>,
        ]);
        if (cancelled) return;
        setUnsolicited(bal > tracked ? bal - tracked : 0n);
        setTokenLookupErr(null);
      } catch (e) {
        if (cancelled) return;
        setTokenLookupErr((e as Error).message ?? 'token lookup failed');
        setUnsolicited(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [validToken, tokenInput, address, publicClient, diamondAddress]);

  if (!address) {
    return (
      <div className="page-container">
        <h1>{t('escrowRecover.pageTitle')}</h1>
        <p>{t('escrowRecover.connectBody')}</p>
      </div>
    );
  }
  if (!isCorrectChain) {
    return (
      <div className="page-container">
        <h1>{t('escrowRecover.pageTitle')}</h1>
        <p>{t('escrowRecover.switchChainBody')}</p>
      </div>
    );
  }

  const canReview =
    validToken &&
    validSource &&
    amountValid &&
    unsolicited !== null &&
    parseUnits(amountInput, tokenDecimals) <= unsolicited &&
    status.kind === 'idle';

  // Outcome surfaces — render-and-return shapes.
  if (status.kind === 'success') {
    return (
      <div className="page-container">
        <h1>{t('escrowRecover.pageTitle')}</h1>
        <div
          className="card"
          role="status"
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
            background: 'var(--success-bg, #efe)',
            color: 'var(--success, #060)',
          }}
        >
          <CheckCircle2 size={24} style={{ flexShrink: 0 }} />
          <div>
            <strong>{t('escrowRecover.successTitle')}</strong>
            <p style={{ marginTop: 4 }}>
              {t('escrowRecover.successBody', {
                amount: formatAmount(status.amount, tokenDecimals),
                symbol: status.symbol,
              })}
            </p>
            <p style={{ marginTop: 8, fontSize: '0.85rem' }}>
              <a
                href={`${chain.blockExplorer ?? DEFAULT_CHAIN.blockExplorer}/tx/${status.txHash}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t('escrowRecover.viewTx')}
              </a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status.kind === 'banned') {
    return (
      <div className="page-container">
        <h1>{t('escrowRecover.pageTitle')}</h1>
        <div
          className="card"
          role="alert"
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
            background: 'var(--danger-bg, #fee)',
            color: 'var(--danger, #900)',
          }}
        >
          <Lock size={24} style={{ flexShrink: 0 }} />
          <div>
            <strong>{t('escrowRecover.bannedTitle')}</strong>
            <p style={{ marginTop: 4 }}>
              {t('escrowRecover.bannedBody', {
                source: status.declaredSource,
              })}
            </p>
            <p style={{ marginTop: 4 }}>{t('escrowRecover.bannedAutoUnlock')}</p>
            <p style={{ marginTop: 8, fontSize: '0.85rem' }}>
              <a
                href={`${chain.blockExplorer ?? DEFAULT_CHAIN.blockExplorer}/tx/${status.txHash}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t('escrowRecover.viewTx')}
              </a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <ShieldAlert size={22} />
        {t('escrowRecover.pageTitle')}
      </h1>
      <p style={{ maxWidth: 720 }}>{t('escrowRecover.pageSubtitle')}</p>

      {/* Form */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">{t('escrowRecover.formTitle')}</div>

        <div style={{ marginBottom: 12 }}>
          <label
            htmlFor="rec-token"
            style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}
          >
            {t('escrowRecover.tokenLabel')}
          </label>
          <input
            id="rec-token"
            type="text"
            placeholder="0x…"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value.trim())}
            style={{ width: '100%', padding: 8, fontFamily: 'monospace' }}
          />
          {tokenLookupErr && (
            <p style={{ color: 'var(--danger, #900)', fontSize: '0.85rem' }}>
              {tokenLookupErr}
            </p>
          )}
          {validToken && tokenSymbol && (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              {tokenSymbol} ({tokenDecimals} dec)
              {unsolicited !== null && (
                <>
                  {' · '}
                  {t('escrowRecover.maxRecoverable', {
                    amount: formatAmount(unsolicited, tokenDecimals),
                  })}
                </>
              )}
            </p>
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label
            htmlFor="rec-source"
            style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}
          >
            {t('escrowRecover.sourceLabel')}
          </label>
          <input
            id="rec-source"
            type="text"
            placeholder="0x…"
            value={sourceInput}
            onChange={(e) => setSourceInput(e.target.value.trim())}
            style={{ width: '100%', padding: 8, fontFamily: 'monospace' }}
          />
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {t('escrowRecover.sourceHint')}
          </p>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label
            htmlFor="rec-amount"
            style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}
          >
            {t('escrowRecover.amountLabel')}
          </label>
          <input
            id="rec-amount"
            type="text"
            placeholder="0.0"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value.trim())}
            style={{ width: '100%', padding: 8 }}
          />
        </div>

        <button
          type="button"
          className="btn btn-primary"
          disabled={!canReview}
          onClick={() => {
            setConfirmInput('');
            setStatus({ kind: 'reviewing' });
          }}
        >
          {t('escrowRecover.reviewBtn')}
        </button>
      </div>

      {/* Standing warning panel below the form (always visible). */}
      <div
        className="card"
        role="note"
        style={{
          marginTop: 16,
          background: 'var(--warning-bg, #ffe8c0)',
          color: 'var(--warning-text, #5a3000)',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
        }}
      >
        <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
        <div>
          <strong>{t('escrowRecover.warningTitle')}</strong>
          <ul style={{ marginTop: 4, paddingLeft: 18 }}>
            <li>{t('escrowRecover.warning1')}</li>
            <li>{t('escrowRecover.warning2')}</li>
            <li>{t('escrowRecover.warning3')}</li>
          </ul>
        </div>
      </div>

      {/* Confirmation modal */}
      {status.kind === 'reviewing' && (
        <ReviewModal
          token={tokenInput as Address}
          tokenSymbol={tokenSymbol}
          tokenDecimals={tokenDecimals}
          source={sourceInput as Address}
          amount={parseUnits(amountInput, tokenDecimals)}
          confirmInput={confirmInput}
          setConfirmInput={setConfirmInput}
          onCancel={() => setStatus({ kind: 'idle' })}
          onSign={async () => {
            if (inFlightRef.current) return;
            inFlightRef.current = true;
            try {
              if (!walletClient) {
                setStatus({
                  kind: 'error',
                  message: t('escrowRecover.errWalletUnavailable'),
                });
                return;
              }
              const amountWei = parseUnits(amountInput, tokenDecimals);
              const deadline =
                BigInt(Math.floor(Date.now() / 1000)) +
                BigInt(RECOVERY_DEADLINE_SECONDS);

              // Read live nonce + ackTextHash.
              const [nonce, ackTextHash] = await Promise.all([
                publicClient.readContract({
                  address: diamondAddress,
                  abi: RECOVERY_ABI,
                  functionName: 'recoveryNonce',
                  args: [address as Address],
                }) as Promise<bigint>,
                publicClient.readContract({
                  address: diamondAddress,
                  abi: RECOVERY_ABI,
                  functionName: 'recoveryAckTextHash',
                }) as Promise<Hex>,
              ]);

              setStatus({ kind: 'signing' });
              const signature = (await walletClient.signTypedData({
                account: address as Address,
                domain: {
                  name: 'Vaipakam Recovery',
                  version: '1',
                  chainId: chainId ?? DEFAULT_CHAIN.chainId,
                  verifyingContract: diamondAddress,
                },
                types: RECOVERY_TYPES,
                primaryType: 'RecoveryAcknowledgment',
                message: {
                  user: address as Address,
                  token: tokenInput as Address,
                  declaredSource: sourceInput as Address,
                  amount: amountWei,
                  nonce,
                  deadline,
                  ackTextHash,
                },
              })) as Hex;

              setStatus({ kind: 'submitting' });
              const txHash = await walletClient.writeContract({
                address: diamondAddress,
                abi: RECOVERY_ABI,
                functionName: 'recoverStuckERC20',
                args: [
                  tokenInput as Address,
                  sourceInput as Address,
                  amountWei,
                  deadline,
                  signature,
                ],
                chain: walletClient.chain,
                account: address as Address,
              });
              const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

              // Inspect the tx logs to determine which outcome
              // landed. Both events live on the diamond.
              let outcome: Status = {
                kind: 'error',
                message: t('escrowRecover.errOutcomeMissing'),
              };
              for (const log of receipt.logs) {
                if (log.address.toLowerCase() !== diamondAddress.toLowerCase()) continue;
                try {
                  const decoded = decodeEventLog({
                    abi: RECOVERY_ABI,
                    data: log.data,
                    topics: log.topics,
                  });
                  if (decoded.eventName === 'StuckERC20Recovered') {
                    outcome = {
                      kind: 'success',
                      txHash,
                      amount: amountWei,
                      symbol: tokenSymbol,
                    };
                    break;
                  }
                  if (decoded.eventName === 'EscrowBannedFromRecoveryAttempt') {
                    outcome = {
                      kind: 'banned',
                      txHash,
                      declaredSource: sourceInput as Address,
                    };
                    break;
                  }
                } catch {
                  // Not one of our events; skip.
                }
              }
              setStatus(outcome);
            } catch (e) {
              const msg = (e as Error).message ?? String(e);
              setStatus({ kind: 'error', message: msg });
            } finally {
              inFlightRef.current = false;
            }
          }}
          status={status}
        />
      )}

      {status.kind === 'error' && (
        <div
          className="card"
          role="alert"
          style={{
            marginTop: 16,
            background: 'var(--danger-bg, #fee)',
            color: 'var(--danger, #900)',
          }}
        >
          <strong>{t('escrowRecover.errTitle')}</strong>
          <p style={{ marginTop: 4, fontFamily: 'monospace', fontSize: '0.85rem' }}>
            {status.message}
          </p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 8 }}
            onClick={() => setStatus({ kind: 'idle' })}
          >
            {t('escrowRecover.retry')}
          </button>
        </div>
      )}
    </div>
  );
}

interface ReviewModalProps {
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  source: Address;
  amount: bigint;
  confirmInput: string;
  setConfirmInput: (v: string) => void;
  onCancel: () => void;
  onSign: () => void;
  status: Status;
}

function ReviewModal({
  token,
  tokenSymbol,
  tokenDecimals,
  source,
  amount,
  confirmInput,
  setConfirmInput,
  onCancel,
  onSign,
  status,
}: ReviewModalProps) {
  const { t } = useTranslation();
  const confirmReady = confirmInput.trim().toUpperCase() === 'CONFIRM';
  const inFlight = status.kind === 'signing' || status.kind === 'submitting';
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        className="card"
        style={{
          maxWidth: 540,
          width: '94%',
          background: 'var(--bg, #fff)',
          padding: 20,
        }}
      >
        <div className="card-title">{t('escrowRecover.modalTitle')}</div>

        <table style={{ width: '100%', marginBottom: 16 }}>
          <tbody>
            <tr>
              <td style={{ paddingRight: 8, color: 'var(--text-secondary)' }}>
                {t('escrowRecover.modalToken')}
              </td>
              <td style={{ fontFamily: 'monospace' }}>
                {tokenSymbol} ({token.slice(0, 6)}…{token.slice(-4)})
              </td>
            </tr>
            <tr>
              <td style={{ paddingRight: 8, color: 'var(--text-secondary)' }}>
                {t('escrowRecover.modalSource')}
              </td>
              <td style={{ fontFamily: 'monospace' }}>
                {source.slice(0, 6)}…{source.slice(-4)}
              </td>
            </tr>
            <tr>
              <td style={{ paddingRight: 8, color: 'var(--text-secondary)' }}>
                {t('escrowRecover.modalAmount')}
              </td>
              <td style={{ fontFamily: 'monospace' }}>
                {formatAmount(amount, tokenDecimals)} {tokenSymbol}
              </td>
            </tr>
          </tbody>
        </table>

        <div
          style={{
            background: 'var(--warning-bg, #ffe8c0)',
            color: 'var(--warning-text, #5a3000)',
            padding: 12,
            borderRadius: 4,
            marginBottom: 16,
            fontSize: '0.9rem',
          }}
        >
          <strong>⚠️ {t('escrowRecover.modalWarningHeader')}</strong>
          <p style={{ marginTop: 4 }}>{t('escrowRecover.modalWarningSanctions')}</p>
          <p style={{ marginTop: 4 }}>{t('escrowRecover.modalWarningOwnership')}</p>
        </div>

        <label
          htmlFor="rec-confirm"
          style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}
        >
          {t('escrowRecover.modalConfirmPrompt')}
        </label>
        <input
          id="rec-confirm"
          type="text"
          value={confirmInput}
          onChange={(e) => setConfirmInput(e.target.value)}
          placeholder="CONFIRM"
          style={{ width: '100%', padding: 8, marginBottom: 16, fontFamily: 'monospace' }}
          disabled={inFlight}
        />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={inFlight}
          >
            {t('escrowRecover.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!confirmReady || inFlight}
            onClick={onSign}
          >
            {status.kind === 'signing'
              ? t('escrowRecover.signingState')
              : status.kind === 'submitting'
                ? t('escrowRecover.submittingState')
                : t('escrowRecover.signBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatAmount(amount: bigint, decimals: number): string {
  // Lightweight formatter — split int/frac, trim trailing zeros, max
  // 6 fractional digits to keep the UI readable.
  if (amount === 0n) return '0';
  const factor = 10n ** BigInt(decimals);
  const integer = amount / factor;
  const fraction = amount % factor;
  if (fraction === 0n) return integer.toString();
  let fracStr = fraction.toString().padStart(decimals, '0').slice(0, 6);
  fracStr = fracStr.replace(/0+$/, '');
  return fracStr ? `${integer.toString()}.${fracStr}` : integer.toString();
}
