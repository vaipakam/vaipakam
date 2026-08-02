/**
 * Stuck-token recovery (T-054 PR-4, defi /recover ported onto
 * alpha02's UI/UX) — returns ERC-20s that landed in the user's vault
 * proxy OUTSIDE the protocol deposit flow (mistaken direct transfer,
 * third-party dust) to the connected wallet.
 *
 * DELIBERATELY UNLISTED — no nav or Settings entry; noindex in
 * SeoMeta + _headers. The only in-app path here is the Help page's
 * stuck-token explainer. That discoverability gate is part of the
 * security design (as in the defi original): a user dust-poisoned by
 * a stranger must read WHY recovering unknown dust is dangerous
 * before they can find the button — declaring a sanctions-listed
 * source LOCKS recovery for their vault, and `recoverStuckERC20`
 * deliberately does NOT revert on that path (the ban-state writes
 * must persist), so the outcome is read from the receipt's events:
 *   StuckERC20Recovered            → success
 *   VaultBannedFromRecoveryAttempt → ban-as-outcome
 *
 * Flow (alpha02 in-page steps, no modal): form → review card with the
 * typed-CONFIRM friction → EIP-712 acknowledgement signature → tx →
 * outcome card. The typed CONFIRM is a deliberate speed bump, kept
 * from the original.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, Lock, ShieldAlert, TriangleAlert } from 'lucide-react';
import { isAddress, parseUnits, decodeEventLog, type Hex } from 'viem';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { captureTxError } from '../lib/errors';
import { formatTokenAmount, shortAddress } from '../lib/format';

/** EIP-712 shape — must match VaultFactoryFacet's RECOVERY_TYPEHASH
 *  exactly, or the recovered signer won't equal msg.sender and the
 *  contract reverts RecoverySignatureInvalid. */
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

const RECOVERY_DEADLINE_SECONDS = 30 * 60;

/** UI friction constant, not copy — the user types this literal to
 *  arm the sign button (same untranslated rule as signing text). */
const CONFIRM_WORD = 'CONFIRM';

const ERC20_META_ABI = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

type Step =
  | { kind: 'form' }
  | { kind: 'review' }
  | { kind: 'submitting' }
  | { kind: 'success'; txHash: Hex; amount: bigint }
  | { kind: 'banned'; txHash: Hex; declaredSource: string };

export function Recover() {
  const { address, onSupportedChain, walletChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { data: walletClient } = useWalletClient();

  const [tokenInput, setTokenInput] = useState('');
  const [sourceInput, setSourceInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [confirmInput, setConfirmInput] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  // Fail-safe availability probe: `recoverStuckERC20` HARD-REQUIRES
  // the sanctions oracle (it reverts SanctionsOracleUnavailable when
  // unset — the outcome can't be adjudicated without screening the
  // declared source). Never let the user sign into that: with the
  // oracle unset OR the probe failing, the flow renders a blocked
  // state instead of the form (per the WebsiteReadme recovery spec).
  // null = probing.
  const [oracleReady, setOracleReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!publicClient || !walletChain) {
      setOracleReady(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const oracle = (await publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getSanctionsOracle',
        })) as string;
        if (cancelled) return;
        setOracleReady(
          oracle.toLowerCase() !== '0x0000000000000000000000000000000000000000',
        );
      } catch {
        if (!cancelled) setOracleReady(false); // fail-safe: blocked
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, walletChain]);

  // Live token meta + the unsolicited-surplus cap for the entered
  // token: surplus = max(0, balanceOf(vault) − protocol-tracked).
  const [tokenSymbol, setTokenSymbol] = useState('');
  const [tokenDecimals, setTokenDecimals] = useState(18);
  const [surplus, setSurplus] = useState<bigint | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);

  const validToken = isAddress(tokenInput);
  const validSource = isAddress(sourceInput);
  const amountWei = useMemo(() => {
    if (!amountInput) return null;
    try {
      const v = parseUnits(amountInput, tokenDecimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amountInput, tokenDecimals]);

  useEffect(() => {
    if (!validToken || !address || !publicClient || !walletChain) {
      setTokenSymbol('');
      setTokenDecimals(18);
      setSurplus(null);
      setLookupFailed(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // One pinned block for the balance/tracked pair — the surplus
        // must not straddle a deposit landing mid-read.
        const blockNumber = await publicClient.getBlockNumber();
        const token = tokenInput as `0x${string}`;
        const [sym, dec, vault] = await Promise.all([
          publicClient.readContract({
            address: token,
            abi: ERC20_META_ABI,
            functionName: 'symbol',
            blockNumber,
          }),
          publicClient.readContract({
            address: token,
            abi: ERC20_META_ABI,
            functionName: 'decimals',
            blockNumber,
          }),
          publicClient.readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getUserVaultAddress',
            args: [address],
            blockNumber,
          }) as Promise<`0x${string}`>,
        ]);
        if (cancelled) return;
        setTokenSymbol(sym as string);
        setTokenDecimals(Number(dec));
        if (vault === '0x0000000000000000000000000000000000000000') {
          setSurplus(0n);
          setLookupFailed(false);
          return;
        }
        const [bal, tracked] = await Promise.all([
          publicClient.readContract({
            address: token,
            abi: ERC20_META_ABI,
            functionName: 'balanceOf',
            args: [vault],
            blockNumber,
          }) as Promise<bigint>,
          publicClient.readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getProtocolTrackedVaultBalance',
            args: [address, token],
            blockNumber,
          }) as Promise<bigint>,
        ]);
        if (cancelled) return;
        setSurplus(bal > tracked ? bal - tracked : 0n);
        setLookupFailed(false);
      } catch {
        if (cancelled) return;
        setSurplus(null);
        setLookupFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [validToken, tokenInput, address, publicClient, walletChain]);

  const canReview =
    validToken &&
    validSource &&
    amountWei !== null &&
    surplus !== null &&
    amountWei <= surplus;

  async function signAndSubmit() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    try {
      if (!walletClient || !publicClient || !address || !walletChain) {
        throw new Error(copy.errors.walletConnectFirst);
      }
      const diamond = walletChain.diamondAddress;
      const token = tokenInput as `0x${string}`;
      const declaredSource = sourceInput as `0x${string}`;
      const amount = amountWei!;
      const deadline =
        BigInt(Math.floor(Date.now() / 1000)) + BigInt(RECOVERY_DEADLINE_SECONDS);

      const [nonce, ackTextHash] = await Promise.all([
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'recoveryNonce',
          args: [address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'recoveryAckTextHash',
        }) as Promise<Hex>,
      ]);

      const signature = await walletClient.signTypedData({
        account: address,
        domain: {
          name: 'Vaipakam Recovery',
          version: '1',
          chainId: walletChain.chainId,
          verifyingContract: diamond,
        },
        types: RECOVERY_TYPES,
        primaryType: 'RecoveryAcknowledgment',
        message: {
          user: address,
          token,
          declaredSource,
          amount,
          nonce,
          deadline,
          ackTextHash,
        },
      });

      setStep({ kind: 'submitting' });
      const txHash = await walletClient.writeContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'recoverStuckERC20',
        args: [token, declaredSource, amount, deadline, signature],
        chain: walletClient.chain,
        account: address,
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      // The contract deliberately does NOT revert on the sanctioned-
      // source path — read the outcome from the emitted event.
      let outcome: Step | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: DIAMOND_ABI_VIEM,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === 'StuckERC20Recovered') {
            outcome = { kind: 'success', txHash, amount };
            break;
          }
          if (decoded.eventName === 'VaultBannedFromRecoveryAttempt') {
            outcome = { kind: 'banned', txHash, declaredSource };
            break;
          }
        } catch {
          // Some other event on the diamond — skip.
        }
      }
      if (outcome) {
        setStep(outcome);
      } else {
        setStep({ kind: 'review' });
        setError(copy.recover.errOutcomeMissing);
      }
    } catch (err) {
      setStep({ kind: 'review' });
      setError(captureTxError(err));
    } finally {
      inFlightRef.current = false;
    }
  }

  const explorerTx = (txHash: Hex) =>
    `${walletChain?.blockExplorer}/tx/${txHash}`;

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">{copy.recover.title}</h1>
        <p className="page-lede">{copy.recover.lede}</p>
      </div>

      {/* The Help explainer is the intended way in — nudge anyone who
          landed here cold back to it before they touch anything. */}
      <p className="muted" style={{ margin: 0 }}>
        {copy.recover.helpFirst}{' '}
        <Link to="/help#stuck-tokens">{copy.chrome.nav.help}</Link>
      </p>

      {!address ? (
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>
            {copy.wallet.connectFirst}
          </p>
        </section>
      ) : !onSupportedChain || !walletChain ? (
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">{copy.recover.wrongChain}</span>
        </div>
      ) : oracleReady === null ? (
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>
            {copy.recover.checkingAvailability}
          </p>
        </section>
      ) : oracleReady === false ? (
        <div className="banner banner-warn" role="alert">
          <Lock aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.unavailableTitle}</strong>
            <br />
            {copy.recover.unavailableBody}
          </span>
        </div>
      ) : step.kind === 'success' ? (
        <div className="banner banner-info" role="status">
          <CircleCheck aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.successTitle}</strong>
            <br />
            {copy.recover.successBody(
              formatTokenAmount(step.amount, tokenDecimals),
              tokenSymbol,
            )}
            <br />
            <a href={explorerTx(step.txHash)} target="_blank" rel="noreferrer noopener">
              {copy.recover.viewTx}
            </a>
          </span>
        </div>
      ) : step.kind === 'banned' ? (
        <div className="banner banner-danger" role="alert">
          <Lock aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.bannedTitle}</strong>
            <br />
            {copy.recover.bannedBody(shortAddress(step.declaredSource))}{' '}
            {copy.recover.bannedAutoUnlock}
            <br />
            <a href={explorerTx(step.txHash)} target="_blank" rel="noreferrer noopener">
              {copy.recover.viewTx}
            </a>
          </span>
        </div>
      ) : step.kind === 'review' || step.kind === 'submitting' ? (
        <section className="card">
          <div className="card-title">
            <ShieldAlert aria-hidden />
            <h2 style={{ margin: 0 }}>{copy.recover.reviewTitle}</h2>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>
              <span className="muted">{copy.recover.reviewToken}:</span>{' '}
              {tokenSymbol} ({shortAddress(tokenInput)})
            </p>
            <p style={{ margin: 0 }}>
              <span className="muted">{copy.recover.reviewSource}:</span>{' '}
              {shortAddress(sourceInput)}
            </p>
            <p style={{ margin: 0 }}>
              <span className="muted">{copy.recover.reviewAmount}:</span>{' '}
              {amountWei !== null ? formatTokenAmount(amountWei, tokenDecimals) : ''}{' '}
              {tokenSymbol}
            </p>
            <div className="banner banner-warn" role="note">
              <TriangleAlert aria-hidden />
              <span className="banner-body">
                {copy.recover.reviewWarnSanctions}{' '}
                {copy.recover.reviewWarnOwnership}
              </span>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="recover-confirm">{copy.recover.confirmPrompt}</label>
              <input
                id="recover-confirm"
                className="input"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder={CONFIRM_WORD}
                spellCheck={false}
                autoComplete="off"
                disabled={step.kind === 'submitting'}
              />
            </div>
            <div className="cluster">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={step.kind === 'submitting'}
                onClick={() => {
                  setConfirmInput('');
                  setStep({ kind: 'form' });
                }}
              >
                {copy.common.back}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  step.kind === 'submitting' ||
                  confirmInput.trim().toUpperCase() !== CONFIRM_WORD
                }
                onClick={() => void signAndSubmit()}
              >
                {step.kind === 'submitting'
                  ? copy.recover.submitting
                  : copy.recover.sign}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="card">
          <div className="card-title">
            <ShieldAlert aria-hidden />
            <h2 style={{ margin: 0 }}>{copy.recover.formTitle}</h2>
          </div>
          <div className="stack" style={{ gap: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="recover-token">{copy.recover.tokenLabel}</label>
              <input
                id="recover-token"
                className="input"
                placeholder="0x…"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value.trim())}
                spellCheck={false}
                autoComplete="off"
              />
              {lookupFailed ? (
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  {copy.recover.tokenLookupFailed}
                </p>
              ) : validToken && tokenSymbol ? (
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  {copy.recover.tokenMeta(tokenSymbol, String(tokenDecimals))}
                  {surplus !== null ? (
                    <>
                      {' · '}
                      {copy.recover.maxRecoverable(
                        formatTokenAmount(surplus, tokenDecimals),
                      )}
                    </>
                  ) : null}
                </p>
              ) : null}
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="recover-source">{copy.recover.sourceLabel}</label>
              <input
                id="recover-source"
                className="input"
                placeholder="0x…"
                value={sourceInput}
                onChange={(e) => setSourceInput(e.target.value.trim())}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="muted" style={{ margin: '4px 0 0' }}>
                {copy.recover.sourceHint}
              </p>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="recover-amount">{copy.recover.amountLabel}</label>
              <input
                id="recover-amount"
                className="input"
                inputMode="decimal"
                placeholder="0.0"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value.trim())}
                autoComplete="off"
              />
              {amountWei !== null && surplus !== null && amountWei > surplus ? (
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  {copy.recover.overMax}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canReview}
              onClick={() => {
                setConfirmInput('');
                setError(null);
                setStep({ kind: 'review' });
              }}
            >
              {copy.recover.review}
            </button>
          </div>
        </section>
      )}

      {/* Standing warning — visible alongside the form and review. */}
      {oracleReady === true &&
      address &&
      onSupportedChain &&
      (step.kind === 'form' || step.kind === 'review' || step.kind === 'submitting') ? (
        <div className="banner banner-warn" role="note">
          <TriangleAlert aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.warningTitle}</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {copy.recover.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">
            <strong>{copy.recover.errTitle}</strong>
            <br />
            {error}
          </span>
        </div>
      ) : null}
    </div>
  );
}
