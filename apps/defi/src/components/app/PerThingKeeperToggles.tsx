import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../../context/WalletContext';
import { useDiamondContract, useDiamondRead } from '../../contracts/useDiamond';
import { decodeContractError } from '@vaipakam/lib/decodeContractError';
import { AddressDisplay } from './AddressDisplay';
import { KEEPER_ACTION } from '../../pages/KeeperSettings';

/**
 * Per-offer / per-loan keeper toggles (Phase 6 gate 3).
 *
 * The contract enforces three independent gates before a keeper call
 * can land — see `LibAuth.requireKeeperFor`:
 *
 *   1. `keeperAccessEnabled[user]`            — global master switch
 *   2. `approvedKeeperActions[user][keeper]`  — whitelist + action bits
 *   3. `offerKeeperEnabled[offerId][keeper]`  — per-offer flag
 *      `loanKeeperEnabled[loanId][keeper]`    — per-loan flag (post-accept)
 *
 * Gates 1 + 2 live on the dedicated [Keeper Settings page](frontend/src/pages/KeeperSettings.tsx).
 * This component owns gate 3 — surfaced inline on the offer / loan
 * detail pages so the user toggles per-keeper authority while looking
 * at the specific position the toggle applies to.
 *
 * Without this UI the third gate stays at its default (`false` for
 * every (thing, keeper) pair), so even with the master switch on +
 * keepers whitelisted on the global page, no keeper can ever act.
 * That's the bug we're closing.
 */

const ACTION_LABELS: Record<keyof typeof KEEPER_ACTION, string> = {
  COMPLETE_LOAN_SALE: 'Complete sale',
  COMPLETE_OFFSET: 'Complete offset',
  INIT_EARLY_WITHDRAW: 'Init withdraw',
  INIT_PRECLOSE: 'Init preclose',
  REFINANCE: 'Refinance',
  // T-092 Phase 3 (#503) — auto-extend in place toggle.
  EXTEND: 'Auto-extend',
};

interface CommonProps {
  /// The user whose whitelist drives the keeper rows. For offers
  /// that's the creator; for loans it's the NFT holder of the side
  /// the caller controls. Component renders nothing if this address
  /// has no whitelisted keepers.
  ownerAddress: string;
  /// When true, render in a read-only "summary" mode (e.g. for
  /// non-creator viewers who want to see who's authorised but
  /// cannot toggle). Default false.
  readOnly?: boolean;
}

export interface PerOfferKeeperTogglesProps extends CommonProps {
  kind: 'offer';
  offerId: bigint;
  /// True when the offer has been accepted — toggles disabled because
  /// the contract reverts `OfferAlreadyAccepted` on `setOfferKeeperEnabled`.
  /// The post-accept lifecycle moves to per-loan toggles.
  isAccepted: boolean;
}

export interface PerLoanKeeperTogglesProps extends CommonProps {
  kind: 'loan';
  loanId: bigint;
  /// Whether this owner is the lender or borrower side. Display-only
  /// — the contract `loanKeeperEnabled` mapping is shared between
  /// both sides (per-side authority is enforced via each side's
  /// own action-bitmask), but the side label clarifies whose
  /// whitelist this list is sourced from.
  side: 'lender' | 'borrower';
}

export type PerThingKeeperTogglesProps =
  | PerOfferKeeperTogglesProps
  | PerLoanKeeperTogglesProps;

interface KeeperRow {
  address: string;
  /// Action bitmask from `getKeeperActions(owner, keeper)`. Used to
  /// render the compact action chips next to the address.
  actions: number;
  /// Current value of `isOfferKeeperEnabled` / `isLoanKeeperEnabled`.
  enabled: boolean;
}

export function PerThingKeeperToggles(props: PerThingKeeperTogglesProps) {
  const { t } = useTranslation();
  const { address } = useWallet();
  const diamondRo = useDiamondRead();
  const diamondRw = useDiamondContract();

  const [rows, setRows] = useState<KeeperRow[]>([]);
  const [masterOn, setMasterOn] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKeeper, setPendingKeeper] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!diamondRo || !props.ownerAddress) return;
    setLoading(true);
    setErr(null);
    try {
      const owner = props.ownerAddress;
      // Master switch state — used to surface a warning banner if it's
      // off (gate 1 missing means even a fully-toggled gate-3 still
      // won't authorise the keeper at call time).
      const master = (await (
        diamondRo as unknown as { getKeeperAccess: (a: string) => Promise<boolean> }
      ).getKeeperAccess(owner)) as boolean;
      setMasterOn(Boolean(master));

      const list = (await (
        diamondRo as unknown as { getApprovedKeepers: (a: string) => Promise<string[]> }
      ).getApprovedKeepers(owner)) as string[];

      // Fetch action bitmask + per-thing flag in parallel for each
      // keeper. The whitelist is bounded by `MAX_APPROVED_KEEPERS`
      // (5) so the fan-out stays small.
      const fetched = await Promise.all(
        list.map(async (keeper): Promise<KeeperRow> => {
          const [actionsBig, enabled] = await Promise.all([
            (
              diamondRo as unknown as {
                getKeeperActions: (a: string, k: string) => Promise<bigint>;
              }
            ).getKeeperActions(owner, keeper),
            props.kind === 'offer'
              ? (
                  diamondRo as unknown as {
                    isOfferKeeperEnabled: (o: bigint, k: string) => Promise<boolean>;
                  }
                ).isOfferKeeperEnabled(props.offerId, keeper)
              : (
                  diamondRo as unknown as {
                    isLoanKeeperEnabled: (l: bigint, k: string) => Promise<boolean>;
                  }
                ).isLoanKeeperEnabled(props.loanId, keeper),
          ]);
          return {
            address: keeper,
            actions: Number(actionsBig),
            enabled: Boolean(enabled),
          };
        }),
      );
      setRows(fetched);
    } catch (e) {
      setErr(decodeContractError(e));
    } finally {
      setLoading(false);
    }
  }, [diamondRo, props]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggle = useCallback(
    async (keeper: string, next: boolean) => {
      if (!diamondRw || pendingKeeper) return;
      setPendingKeeper(keeper);
      setErr(null);
      try {
        const tx =
          props.kind === 'offer'
            ? await (
                diamondRw as unknown as {
                  setOfferKeeperEnabled: (
                    o: bigint,
                    k: string,
                    e: boolean,
                  ) => Promise<{ wait: () => Promise<unknown> }>;
                }
              ).setOfferKeeperEnabled(props.offerId, keeper, next)
            : await (
                diamondRw as unknown as {
                  setLoanKeeperEnabled: (
                    l: bigint,
                    k: string,
                    e: boolean,
                  ) => Promise<{ wait: () => Promise<unknown> }>;
                }
              ).setLoanKeeperEnabled(props.loanId, keeper, next);
        await tx.wait();
        await refresh();
      } catch (e) {
        setErr(decodeContractError(e));
      } finally {
        setPendingKeeper(null);
      }
    },
    [diamondRw, pendingKeeper, props, refresh],
  );

  // Hide entirely when the connected wallet isn't the owner whose
  // whitelist sources the rows — the contract setter would revert
  // `NotNFTOwner` / `creator-only` anyway. The detail page is
  // expected to gate this component on the right `isCreator` /
  // `isLender` / `isBorrower` flag; this is just a defence-in-depth.
  const ownerMatchesCaller =
    address && address.toLowerCase() === props.ownerAddress.toLowerCase();
  if (!ownerMatchesCaller && !props.readOnly) return null;

  if (loading) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-body" style={{ color: 'var(--text-secondary)' }}>
          {t('keeperToggles.loading', { defaultValue: 'Loading keepers…' })}
        </div>
      </div>
    );
  }

  // No whitelisted keepers: prompt the user to set up gate 2 first
  // via the dedicated page. Without a whitelist there's nothing to
  // toggle here.
  if (rows.length === 0) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-body">
          <h3 className="card-title">
            {t('keeperToggles.title', { defaultValue: 'Keepers' })}
          </h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
            {t('keeperToggles.noWhitelist', {
              defaultValue:
                'You haven’t whitelisted any keepers yet. Add one on the Keeper Settings page first, then come back to enable it for this position.',
            })}
          </p>
          <a
            href="/keepers"
            className="btn btn-secondary btn-sm"
            style={{ display: 'inline-block' }}
          >
            {t('keeperToggles.openSettings', {
              defaultValue: 'Open Keeper Settings',
            })}
          </a>
        </div>
      </div>
    );
  }

  const disabledByLifecycle =
    props.kind === 'offer' && props.isAccepted;
  const showMasterWarning = masterOn === false;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-body">
        <h3 className="card-title">
          {props.kind === 'offer'
            ? t('keeperToggles.titleOffer', {
                defaultValue: 'Keepers for this offer',
              })
            : t('keeperToggles.titleLoan', {
                defaultValue: 'Keepers for this loan',
              })}
        </h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 12, fontSize: '0.85rem' }}>
          {props.kind === 'offer'
            ? t('keeperToggles.descOffer', {
                defaultValue:
                  'Pick which of your whitelisted keepers may act on this offer once it’s accepted. The selection latches into the loan at acceptance time.',
              })
            : t('keeperToggles.descLoan', {
                defaultValue:
                  'Pick which of your whitelisted keepers may act on this loan. The flag is shared with the counterparty’s view; per-side authority is enforced by each side’s own action whitelist.',
              })}
        </p>

        {showMasterWarning && (
          <div
            style={{
              border: '1px solid var(--accent-orange)',
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: '0.85rem',
              marginBottom: 12,
              color: 'var(--accent-orange)',
            }}
          >
            {t('keeperToggles.masterOff', {
              defaultValue:
                'Your global keeper switch is OFF. Toggles below will save, but no keeper can act until you turn the switch on at Keeper Settings.',
            })}
          </div>
        )}

        {disabledByLifecycle && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: '0.85rem',
              marginBottom: 12,
              color: 'var(--text-secondary)',
            }}
          >
            {t('keeperToggles.offerAccepted', {
              defaultValue:
                'This offer has been accepted. The keeper selection has latched into the loan; manage it from the Loan details page.',
            })}
          </div>
        )}

        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((row) => {
            const busy = pendingKeeper === row.address;
            const inputDisabled =
              busy || disabledByLifecycle || pendingKeeper !== null;
            return (
              <li
                key={row.address}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 0',
                  borderBottom: '1px solid var(--border)',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    disabled={inputDisabled}
                    onChange={(e) => onToggle(row.address, e.target.checked)}
                    aria-label={t('keeperToggles.toggleAria', {
                      defaultValue: 'Toggle keeper {{address}}',
                      address: row.address,
                    })}
                  />
                  <AddressDisplay address={row.address} withTooltip copyable />
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 4,
                    justifyContent: 'flex-end',
                  }}
                >
                  {(Object.keys(KEEPER_ACTION) as Array<keyof typeof KEEPER_ACTION>)
                    .filter((k) => (row.actions & KEEPER_ACTION[k]) !== 0)
                    .map((k) => (
                      <span
                        key={k}
                        className="status-badge"
                        style={{
                          fontSize: '0.7rem',
                          padding: '2px 6px',
                          background: 'var(--brand-bg)',
                          color: 'var(--brand)',
                        }}
                      >
                        {ACTION_LABELS[k]}
                      </span>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>

        {err && (
          <div
            style={{
              color: 'var(--accent-red)',
              fontSize: '0.85rem',
              marginTop: 12,
            }}
          >
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
