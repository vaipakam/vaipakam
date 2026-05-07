/**
 * T-042 Phase 4 — Propose-change modal.
 *
 * Single shared modal that handles every knob's propose flow. Three
 * pieces of input the operator provides:
 *
 *   1. Safe address — the multisig that will sign. Persisted in
 *      localStorage so it sticks across sessions on the same browser.
 *   2. New value — bounded by the knob's hard min/max in the
 *      contract; the modal rejects out-of-range values pre-emptively
 *      (the contract would also revert with `ParameterOutOfRange`).
 *   3. For multi-arg setters (e.g. `setFeesConfig` which sets BOTH
 *      treasuryFeeBps and loanInitiationFeeBps in one call), the
 *      modal collects all args. Args other than the one being
 *      modified are pre-populated from the current on-chain values
 *      so unchanged fields stay unchanged.
 *
 * On submit: encode the calldata via `encodeKnobSetCall`, build the
 * Safe deep-link via `buildSafeDeepLink`, open in a new tab, and
 * show a confirmation that the operator's been handed off to Safe.
 *
 * No on-chain write happens from this UI — Safe's flow is the
 * canonical signing surface. We're a calldata composer + deep-link
 * builder.
 */

import { useState, useMemo } from 'react';
import { ExternalLink, Shield, X } from 'lucide-react';
import type { KnobMeta } from '../../lib/protocolConsoleKnobs';
import { encodeKnobSetCall, buildSafeDeepLink } from '../../lib/safeDeepLink';
import { DIAMOND_ABI_VIEM } from '../../contracts/abis';
import {
  formatBound,
  type RawValue,
} from '../../lib/protocolConsoleKnobFormat';

const SAFE_ADDR_KEY = 'vaipakam:admin-safe-address';

interface Props {
  knob: KnobMeta;
  currentValue: RawValue;
  /** Diamond address — encoded as the `to` of the Safe tx. */
  diamondAddress: string;
  /** Active chain id; drives the Safe app URL prefix. */
  chainId: number;
  onClose: () => void;
}

export function ProposeChangeModal({
  knob,
  currentValue,
  diamondAddress,
  chainId,
  onClose,
}: Props) {
  const [safeAddress, setSafeAddress] = useState<string>(() => {
    try {
      return localStorage.getItem(SAFE_ADDR_KEY) ?? '';
    } catch {
      return '';
    }
  });
  // Multi-arg setters: the modal renders one input per arg. The
  // index of the "primary" arg (the one the user typically wants to
  // change) is heuristic — for `setFeesConfig` the primary depends
  // on context. Render all and let the user edit any.
  const [args, setArgs] = useState<string[]>(() =>
    knob.setter.args.map(() => ''),
  );
  const [error, setError] = useState<string | null>(null);
  const [openedUrl, setOpenedUrl] = useState<string | null>(null);

  // Pre-fill the matching arg with the current value (if it
  // structurally maps). For single-arg setters the pre-fill is
  // direct. For multi-arg setters whose arg `name` matches the
  // knob's getter return semantics, we pre-fill that slot.
  useMemo(() => {
    if (args.some((a) => a !== '')) return; // user has typed
    if (currentValue == null) return;
    if (knob.setter.args.length === 1) {
      setArgs([rawToInputString(currentValue)]);
    }
    // For multi-arg setters we leave them empty so the user actively
    // confirms each arg — same-value-as-current is allowed but must
    // be retyped to confirm intent.
  }, [args, currentValue, knob]);

  const handlePropose = () => {
    setError(null);
    if (!isValidAddress(safeAddress)) {
      setError('Enter a valid Safe address (0x… 42-char hex).');
      return;
    }
    // Validate every arg is filled.
    if (args.some((a, i) => knob.setter.args[i].type !== 'bool' && a === '')) {
      setError('All fields are required.');
      return;
    }
    // For numeric knobs, validate the new value is within hard bounds.
    if (knob.hasNumericRange && knob.setter.args.length === 1) {
      try {
        const v = BigInt(args[0]);
        const lo = BigInt(knob.hardMin);
        const hi = BigInt(knob.hardMax);
        if (v < lo || v > hi) {
          setError(
            `Value ${v} is outside the contract hard bound [${lo}, ${hi}]. The setter would revert with ParameterOutOfRange.`,
          );
          return;
        }
      } catch {
        setError('Enter a valid integer.');
        return;
      }
    }
    try {
      localStorage.setItem(SAFE_ADDR_KEY, safeAddress);
    } catch {
      /* swallow */
    }
    let calldata: `0x${string}`;
    try {
      calldata = encodeKnobSetCall(knob, DIAMOND_ABI_VIEM, args);
    } catch (e) {
      setError(`Calldata encoding failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const url = buildSafeDeepLink({
      safe: safeAddress,
      chainId,
      to: diamondAddress,
      data: calldata,
    });
    if (!url) {
      setError(
        `Chain id ${chainId} isn't currently supported by Safe. Use a Safe-supported chain or coordinate signers manually.`,
      );
      return;
    }
    setOpenedUrl(url);
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card"
        style={{
          maxWidth: 520,
          width: '100%',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h3 style={{ margin: 0 }}>Propose change — {knob.label}</h3>
          <button
            type="button"
            aria-label="close"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit' }}
          >
            <X size={18} />
          </button>
        </div>

        <p style={{ margin: 0, fontSize: '0.85rem', opacity: 0.85, lineHeight: 1.5 }}>
          {knob.short}
        </p>
        <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.7 }}>
          Current: <strong>{rawToInputString(currentValue)}</strong> · Hard
          bound: {formatBound(knob.hardMin, knob.unit)} –{' '}
          {formatBound(knob.hardMax, knob.unit)}
        </p>

        <div
          style={{
            background: 'rgba(245,158,11,0.12)',
            border: '1px solid rgba(245,158,11,0.4)',
            borderRadius: 4,
            padding: '10px 12px',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            fontSize: '0.82rem',
            lineHeight: 1.45,
          }}
        >
          <Shield size={16} style={{ flexShrink: 0, marginTop: 2, color: '#f59e0b' }} />
          <span>
            <strong>Sign in Safe.</strong> Submitting opens app.safe.global
            with this transaction pre-filled. The proposal won't take
            effect until enough Safe signers approve and any timelock
            delay elapses. Vaipakam never signs on your behalf.
          </span>
        </div>

        <label style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Safe address</span>
          <input
            type="text"
            className="form-input"
            placeholder="0x… (the multisig that will sign)"
            value={safeAddress}
            onChange={(e) => setSafeAddress(e.target.value.trim())}
            spellCheck={false}
          />
        </label>

        {knob.setter.args.map((arg, i) => (
          <label
            key={arg.name}
            style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            <span>
              {arg.name} <span style={{ opacity: 0.5 }}>({arg.type})</span>
            </span>
            <input
              type="text"
              className="form-input"
              placeholder={
                arg.type === 'bool'
                  ? 'true / false'
                  : arg.type === 'address'
                    ? '0x…'
                    : arg.type === 'bytes32'
                      ? '0x… (32 bytes)'
                      : 'integer'
              }
              value={args[i]}
              onChange={(e) => {
                const next = [...args];
                next[i] = e.target.value.trim();
                setArgs(next);
              }}
              spellCheck={false}
            />
          </label>
        ))}

        {error && (
          <p
            style={{
              margin: 0,
              fontSize: '0.82rem',
              color: 'var(--knob-zone-caution, #ef4444)',
            }}
          >
            {error}
          </p>
        )}

        {openedUrl && (
          <p style={{ margin: 0, fontSize: '0.82rem', opacity: 0.85 }}>
            Opened Safe in a new tab. If it didn't open,{' '}
            <a
              href={openedUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--brand)' }}
            >
              click here
            </a>
            .
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handlePropose}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            Open in Safe <ExternalLink size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function isValidAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function rawToInputString(raw: RawValue): string {
  if (raw == null) return '';
  if (typeof raw === 'bigint') return raw.toString();
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return raw;
}
