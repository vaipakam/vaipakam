/**
 * T-042 Phase 2 — knob card with live on-chain value.
 *
 * Single card variant — Phase 3 wraps this in a theme-aware
 * container so the same component renders professionally on the
 * public dashboard and as a Bloomberg-style terminal cell when an
 * admin wallet connects (or the user manually toggles the
 * mission-control view).
 *
 * Card layout:
 *   - Title row: knob label + info-icon → docs anchor.
 *   - Current value: prominent, formatted per unit.
 *   - Status pill: zone classification ("safe" / "mid" / "caution"
 *     for numeric knobs; "enabled" / "disabled" for bool;
 *     "configured" / "unset" for address / bytes32).
 *   - Zone bar (numeric only): segmented coloured rail with marker.
 *   - Setter hint: short attribution to the contract function
 *     responsible — useful for auditors, no-op for end-users.
 *
 * The cards intentionally surface every detail an auditor might want
 * (current value + bound + setter selector) without any interaction
 * — Phase 4 layers the "propose change" button on top.
 */

import { useState } from 'react';
import { Clock, Info, Settings2 } from 'lucide-react';
import {
  classifyValue,
  type KnobMeta,
  type KnobZone,
} from '../../lib/adminKnobsZones';
import {
  formatKnobValue,
  type RawValue,
} from '../../lib/adminKnobFormat';
import type { KnobReadResult } from '../../hooks/useAdminKnobValues';
import type { PendingChange } from '../../hooks/useTimelockPendingChanges';
import { KnobZoneBar } from './KnobZoneBar';
import { ProposeChangeModal } from './ProposeChangeModal';

interface Props {
  knob: KnobMeta;
  read: KnobReadResult;
  docsBase: string;
  /** When true, the card renders the "Propose change" button. Only
   *  set by `AdminDashboard` when the connected wallet has an
   *  admin/governance role. */
  canPropose?: boolean;
  /** Diamond address — required when `canPropose` is true so the
   *  modal can encode the calldata and build the Safe deep-link. */
  diamondAddress?: string;
  chainId?: number;
  /** Pending governance changes targeting this knob (Phase 4b). */
  pending?: PendingChange[];
}

export function KnobCard({ knob, read, docsBase, canPropose, diamondAddress, chainId, pending }: Props) {
  const infoHref = `${docsBase}#${knob.infoAnchor}`;
  const valueText = read.loading ? '…' : formatKnobValue(read.value, knob);
  const [proposeOpen, setProposeOpen] = useState(false);

  const status = readStatus(knob, read);

  return (
    <div
      className="card"
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 140,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 8,
        }}
      >
        <h3 style={{ fontSize: '1rem', margin: 0 }}>{knob.label}</h3>
        <a
          href={infoHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`More info about ${knob.label}`}
          style={{ color: 'var(--brand)', flexShrink: 0 }}
        >
          <Info size={16} />
        </a>
      </div>

      <p style={{ margin: 0, fontSize: '0.82rem', opacity: 0.85, lineHeight: 1.4 }}>
        {knob.short}
      </p>

      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          marginTop: 4,
        }}
      >
        <span
          style={{
            fontSize: '1.15rem',
            fontWeight: 600,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          }}
        >
          {valueText}
        </span>
        <StatusPill status={status} />
      </div>

      {knob.hasNumericRange && <KnobZoneBar knob={knob} value={read.value} />}

      {pending && pending.length > 0 && (
        <PendingChangeBanner pending={pending} />
      )}

      {read.error && (
        <p style={{ margin: 0, fontSize: '0.72rem', opacity: 0.55, color: 'var(--knob-zone-caution, #ef4444)' }}>
          read failed: {read.error}
        </p>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          marginTop: 'auto',
          paddingTop: 4,
        }}
      >
        <p style={{ margin: 0, fontSize: '0.72rem', opacity: 0.5 }}>
          {knob.setter.facet}.{knob.setter.fn}
        </p>
        {canPropose && diamondAddress && chainId !== undefined && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setProposeOpen(true)}
            style={{
              fontSize: '0.72rem',
              padding: '4px 10px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Settings2 size={12} />
            Propose
          </button>
        )}
      </div>

      {proposeOpen && diamondAddress && chainId !== undefined && (
        <ProposeChangeModal
          knob={knob}
          currentValue={read.value}
          diamondAddress={diamondAddress}
          chainId={chainId}
          onClose={() => setProposeOpen(false)}
        />
      )}
    </div>
  );
}

type Status = 'safe' | 'mid' | 'caution' | 'enabled' | 'disabled' | 'configured' | 'unset' | 'loading';

function readStatus(knob: KnobMeta, read: KnobReadResult): Status {
  if (read.loading) return 'loading';
  if (read.value == null) return 'unset';

  switch (knob.unit) {
    case 'bool':
      return read.value === true ? 'enabled' : 'disabled';
    case 'address':
    case 'bytes32': {
      const v = read.value as RawValue;
      if (typeof v !== 'string') return 'unset';
      const isZero =
        v === '0x0000000000000000000000000000000000000000' ||
        v ===
          '0x0000000000000000000000000000000000000000000000000000000000000000';
      return isZero ? 'unset' : 'configured';
    }
    default:
      if (typeof read.value !== 'bigint') return 'unset';
      return classifyValue(knob, read.value);
  }
}

function StatusPill({ status }: { status: Status }) {
  const palette: Record<Status, { bg: string; fg: string; label: string }> = {
    safe: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'SAFE' },
    mid: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', label: 'MID' },
    caution: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', label: 'CAUTION' },
    enabled: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'ON' },
    disabled: { bg: 'rgba(107,114,128,0.18)', fg: '#9ca3af', label: 'OFF' },
    configured: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'SET' },
    unset: { bg: 'rgba(107,114,128,0.18)', fg: '#9ca3af', label: 'UNSET' },
    loading: { bg: 'rgba(107,114,128,0.10)', fg: '#9ca3af', label: '…' },
  };
  const s = palette[status];
  return (
    <span
      style={{
        background: s.bg,
        color: s.fg,
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: '0.7rem',
        fontWeight: 600,
        letterSpacing: '0.04em',
      }}
    >
      {s.label}
    </span>
  );
}

// Keep `KnobZone` re-export-friendly for any caller that wants it
// alongside the card.
export type { KnobZone };

/**
 * Inline badge surfacing a queued timelock proposal targeting this
 * knob. Renders amber when the proposal is still in the delay
 * window ("executes in 47h"); green when the delay has elapsed and
 * the proposal is ready to execute ("ready to execute").
 *
 * When multiple proposals queue against the same knob, shows the
 * count with the soonest-executing window. Operators can drill in
 * via the underlying timelock contract's events explorer for full
 * detail.
 */
function PendingChangeBanner({ pending }: { pending: PendingChange[] }) {
  // Pick the soonest-executing pending change to drive the time
  // hint. Already-ready proposals sort first.
  const sorted = [...pending].sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return a.executesAt - b.executesAt;
  });
  const lead = sorted[0];
  const count = pending.length;
  const ready = lead.ready;
  const now = Math.floor(Date.now() / 1000);
  const seconds = Math.max(0, lead.executesAt - now);
  const timeText = ready
    ? 'ready to execute'
    : `executes in ${formatDelay(seconds)}`;
  const color = ready ? 'var(--knob-zone-safe, #10b981)' : 'var(--knob-zone-mid, #f59e0b)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: '0.72rem',
        color,
        border: `1px solid ${color}`,
        background: 'rgba(245,158,11,0.06)',
        padding: '4px 8px',
        borderRadius: 4,
        letterSpacing: '0.04em',
      }}
    >
      <Clock size={11} aria-hidden="true" />
      <span>
        <strong>{count} PENDING</strong> · {lead.functionName} · {timeText}
      </span>
    </div>
  );
}

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
