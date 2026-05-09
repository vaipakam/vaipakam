/**
 * T-044 — admin-console card for the loan-default grace schedule.
 *
 * The schedule is a fixed 6-slot positional table (see the contract
 * comment on `LibVaipakam.graceSlotBounds` for the canonical bounds).
 * This card is bespoke — it doesn't use `KnobCard` because the data
 * shape (array-of-tuples) doesn't fit the scalar `KnobMeta` pattern
 * the other 17 knobs share.
 *
 * Public-view rendering: read-only table of the current schedule
 * (with each row's per-slot bounds shown as `[min, max]` hints).
 *
 * Admin-view rendering: same table, but each row gets editable inputs
 * for `maxDurationDays` and `graceSeconds`. An "Edit" button toggles
 * an inline form; "Propose change" composes the
 * `setGraceBuckets(GraceBucket[6])` calldata via viem and opens Safe
 * in a new tab — Vaipakam never signs.
 */

import { useState } from 'react';
import { ExternalLink, Info, Settings2, Save, X, AlertTriangle } from 'lucide-react';
import { encodeFunctionData } from 'viem';
import { DIAMOND_ABI_VIEM } from '../../contracts/abis';
import { buildSafeDeepLink } from '../../lib/safeDeepLink';
import {
  useGraceBuckets,
  type GraceBucket,
  type GraceSlotBounds,
} from '../../hooks/useGraceBuckets';

const SAFE_ADDR_KEY = 'vaipakam:admin-safe-address';

interface Props {
  docsBase: string;
  /** When true, the card renders the editor + propose button. */
  canPropose?: boolean;
  /** Diamond address — required when `canPropose` is true. */
  diamondAddress?: string;
  chainId?: number;
}

export function GraceBucketsCard({
  docsBase,
  canPropose,
  diamondAddress,
  chainId,
}: Props) {
  const { buckets, slotBounds, usingDefaults, loading, error, reload } =
    useGraceBuckets();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<GraceBucket[] | null>(null);
  const [safeAddress, setSafeAddress] = useState<string>(() => {
    try {
      return localStorage.getItem(SAFE_ADDR_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [openedUrl, setOpenedUrl] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const infoHref = `${docsBase}#grace-buckets`;
  const slots = buckets ?? [];
  const bounds = slotBounds ?? [];

  // When entering edit mode, snapshot the current schedule into the
  // draft so the inputs are pre-filled with the live values.
  const beginEdit = () => {
    setDraft(slots.map((b) => ({ ...b })));
    setEditing(true);
    setOpenedUrl(null);
    setValidationError(null);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft(null);
    setValidationError(null);
  };

  const updateRow = (
    idx: number,
    field: 'maxDurationDays' | 'graceSeconds',
    raw: string,
  ) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = prev.map((b) => ({ ...b }));
      try {
        next[idx] = {
          ...next[idx],
          [field]: BigInt(raw === '' ? '0' : raw),
        };
      } catch {
        // ignore non-numeric input
      }
      return next;
    });
  };

  const propose = () => {
    setValidationError(null);
    setOpenedUrl(null);
    if (!draft || !diamondAddress || !chainId || !safeAddress) {
      setValidationError('Safe address required.');
      return;
    }
    // Pre-flight client-side validation against the per-slot bounds —
    // catches typos before the operator hands off to Safe.
    const v = validateAgainstBounds(draft, bounds);
    if (v) {
      setValidationError(v);
      return;
    }
    let data: `0x${string}`;
    try {
      data = encodeFunctionData({
        abi: DIAMOND_ABI_VIEM,
        functionName: 'setGraceBuckets',
        args: [draft],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setValidationError(`Calldata encoding failed: ${msg.slice(0, 120)}`);
      return;
    }
    const url = buildSafeDeepLink({
      chainId,
      safe: safeAddress,
      to: diamondAddress,
      data,
    });
    if (!url) {
      setValidationError(
        `Safe is not supported on chain ${chainId}. Use the Diamond address directly via your multisig provider.`,
      );
      return;
    }
    try {
      localStorage.setItem(SAFE_ADDR_KEY, safeAddress);
    } catch {
      // ignore — quota / private mode
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    setOpenedUrl(url);
  };

  return (
    <div
      className="card"
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 8,
        }}
      >
        <div>
          <h3 style={{ fontSize: '1rem', margin: 0 }}>
            Loan-default grace schedule
          </h3>
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
              marginTop: 4,
            }}
          >
            Per-duration window after `endTime` before a loan can be
            marked defaulted. Six fixed slots; each slot's values are
            bounded.
          </div>
        </div>
        <a
          href={infoHref}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--brand)', flexShrink: 0 }}
          aria-label="Grace-bucket docs"
        >
          <Info size={16} />
        </a>
      </div>

      {usingDefaults && !loading && (
        <div
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-secondary)',
            border: '1px dashed var(--border)',
            borderRadius: 6,
            padding: '6px 10px',
          }}
        >
          Compile-time defaults in force (no admin override). Editing
          here will write the schedule to storage.
        </div>
      )}

      {loading && <div>Loading…</div>}
      {error && (
        <div style={{ color: 'var(--danger)' }}>Error: {error}</div>
      )}

      {!loading && !error && buckets && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th style={th()}>#</th>
                <th style={th()}>Bucket label</th>
                <th style={th()}>maxDurationDays</th>
                <th style={th()}>graceSeconds</th>
                <th style={th()}>Effective grace</th>
              </tr>
            </thead>
            <tbody>
              {(editing ? draft ?? [] : buckets).map((b, i) => {
                const bnd = bounds[i];
                const label = bucketLabel(i, b);
                return (
                  <tr key={i}>
                    <td style={td()}>{i}</td>
                    <td style={td()}>{label}</td>
                    <td style={td()}>
                      {editing && i < 5 ? (
                        <input
                          type="number"
                          value={b.maxDurationDays.toString()}
                          onChange={(e) =>
                            updateRow(i, 'maxDurationDays', e.target.value)
                          }
                          style={inputStyle()}
                        />
                      ) : (
                        <span>{b.maxDurationDays.toString()}</span>
                      )}
                      {bnd && i < 5 && (
                        <div style={hintStyle()}>
                          [{bnd.minDays.toString()}, {bnd.maxDays.toString()}]
                        </div>
                      )}
                      {bnd && i === 5 && (
                        <div style={hintStyle()}>catch-all (must be 0)</div>
                      )}
                    </td>
                    <td style={td()}>
                      {editing ? (
                        <input
                          type="number"
                          value={b.graceSeconds.toString()}
                          onChange={(e) =>
                            updateRow(i, 'graceSeconds', e.target.value)
                          }
                          style={inputStyle()}
                        />
                      ) : (
                        <span>{b.graceSeconds.toString()}</span>
                      )}
                      {bnd && (
                        <div style={hintStyle()}>
                          [{formatSeconds(bnd.minGrace)}, {formatSeconds(bnd.maxGrace)}]
                        </div>
                      )}
                    </td>
                    <td style={td()}>{formatSeconds(b.graceSeconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canPropose && diamondAddress && chainId && (
        <div style={{ marginTop: 8 }}>
          {!editing ? (
            <button
              type="button"
              onClick={beginEdit}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Settings2 size={14} /> Edit schedule
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <label style={{ fontSize: '0.8rem' }}>Safe address:</label>
                <input
                  type="text"
                  value={safeAddress}
                  onChange={(e) => setSafeAddress(e.target.value.trim())}
                  placeholder="0x..."
                  style={{ ...inputStyle(), width: '24em' }}
                />
              </div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--warn-text, #cc7a00)',
                  background: 'rgba(255, 165, 0, 0.08)',
                  border: '1px solid rgba(255, 165, 0, 0.4)',
                  borderRadius: 6,
                  padding: '6px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <AlertTriangle size={14} /> You sign in Safe — Vaipakam never
                signs on your behalf.
              </div>
              {validationError && (
                <div style={{ color: 'var(--danger)', fontSize: '0.8rem' }}>
                  {validationError}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={propose}
                  className="btn btn-primary"
                  disabled={!safeAddress}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Save size={14} /> Propose to Safe
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="btn btn-ghost"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <X size={14} /> Cancel
                </button>
                <button
                  type="button"
                  onClick={reload}
                  className="btn btn-ghost"
                  style={{ marginLeft: 'auto' }}
                >
                  Reload current
                </button>
              </div>
              {openedUrl && (
                <a
                  href={openedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: '0.8rem',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  Open in Safe again <ExternalLink size={12} />
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function th(): React.CSSProperties {
  return {
    textAlign: 'left',
    padding: '4px 8px',
    fontSize: '0.75rem',
    color: 'var(--text-secondary)',
    fontWeight: 500,
    borderBottom: '1px solid var(--border)',
  };
}

function td(): React.CSSProperties {
  return {
    padding: '6px 8px',
    fontSize: '0.85rem',
    verticalAlign: 'top',
    borderBottom: '1px solid var(--border)',
  };
}

function inputStyle(): React.CSSProperties {
  return {
    width: '8em',
    padding: '2px 6px',
    border: '1px solid var(--border)',
    borderRadius: 4,
    fontSize: '0.85rem',
  };
}

function hintStyle(): React.CSSProperties {
  return {
    fontSize: '0.7rem',
    color: 'var(--text-secondary)',
    marginTop: 2,
  };
}

function bucketLabel(idx: number, b: GraceBucket): string {
  if (idx === 5) return '≥ previous threshold (catch-all)';
  return `< ${b.maxDurationDays.toString()} days`;
}

function formatSeconds(seconds: bigint): string {
  const s = Number(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function validateAgainstBounds(
  draft: GraceBucket[],
  bounds: GraceSlotBounds[],
): string | null {
  if (draft.length !== 6) return 'Schedule must have exactly 6 slots.';
  if (bounds.length !== 6) return 'Slot bounds not loaded.';
  let prevDays = 0n;
  for (let i = 0; i < 6; i++) {
    const b = draft[i];
    const bnd = bounds[i];
    if (i === 5) {
      if (b.maxDurationDays !== 0n) {
        return `Slot 5 (catch-all) must have maxDurationDays = 0.`;
      }
    } else {
      if (b.maxDurationDays < bnd.minDays || b.maxDurationDays > bnd.maxDays) {
        return `Slot ${i} maxDurationDays ${b.maxDurationDays} out of [${bnd.minDays}, ${bnd.maxDays}].`;
      }
      if (b.maxDurationDays <= prevDays) {
        return `Slot ${i} maxDurationDays must be greater than slot ${i - 1}'s (${prevDays}).`;
      }
      prevDays = b.maxDurationDays;
    }
    if (b.graceSeconds < bnd.minGrace || b.graceSeconds > bnd.maxGrace) {
      return `Slot ${i} graceSeconds ${b.graceSeconds} out of [${bnd.minGrace}, ${bnd.maxGrace}].`;
    }
  }
  return null;
}
