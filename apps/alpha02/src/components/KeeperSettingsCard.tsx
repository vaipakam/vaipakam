/**
 * Keeper permissions manager (Settings, advanced mode) — the
 * per-user half of the Phase 6 trio: the master switch and the
 * per-keeper action whitelist. The per-LOAN enables (the third leg,
 * without which nothing executes) live on each loan's page.
 *
 * Contract quirks encoded here:
 *   - `setKeeperActions` REPLACES the mask — edits always start from
 *     the FETCHED mask, and an entry whose mask failed to read is
 *     not editable (writing a synthesized default would silently
 *     overwrite real permissions).
 *   - mask 0 is invalid on-chain — "uncheck everything" routes to
 *     `revokeKeeper`.
 *   - `approveKeeper` reverts on an existing entry — add vs update
 *     branches on whether the keeper is already listed.
 *   - The whitelist caps at MAX_APPROVED_KEEPERS.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { Bot } from 'lucide-react';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import {
  EXPOSED_ACTIONS_MASK,
  KEEPER_ACTIONS,
  MAX_APPROVED_KEEPERS,
  useKeeperConfig,
} from '../data/keepers';
import { shortAddress } from '../lib/format';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The per-action checkbox list — ONE rendering for the edit and
 *  add surfaces, so the wording of what a grant means can't drift
 *  between them. */
function ActionChecklist({
  bits,
  disabled,
  onToggle,
}: {
  bits: number;
  disabled: boolean;
  onToggle: (bit: number) => void;
}) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {KEEPER_ACTIONS().map((a) => (
        <label key={a.bit} className="cluster" style={{ alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={(bits & a.bit) !== 0}
            disabled={disabled}
            onChange={() => onToggle(a.bit)}
            style={{ marginTop: 3 }}
          />
          <span>
            {a.label}{' '}
            <span className="muted">({a.side}) — {a.blurb}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

export function KeeperSettingsCard() {
  const { address, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const config = useKeeperConfig();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [addressInput, setAddressInput] = useState('');
  // Bits being edited, keyed by keeper (lowercase) or '' for the
  // add-new form. Each draft records the BASE mask it derived from —
  // if the live mask has moved since (a save landed, another device
  // wrote), the draft is stale and is discarded rather than seeding
  // new toggles from pre-save state (which could silently strip a
  // just-granted bit on the next save).
  const [drafts, setDrafts] = useState<Record<string, { base: number; bits: number }>>({});

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient) && Boolean(address);

  async function run(fn: () => Promise<void>, doneMsg: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(doneMsg);
      // AWAIT the refetch: the controls render from query data, so
      // dropping busy before fresh data lands re-enables a checkbox
      // still showing the pre-write value — inviting a duplicate tx.
      await queryClient.invalidateQueries({ queryKey: ['keeperConfig'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleDraft(key: string, bit: number, base: number) {
    setDrafts((d) => {
      const entry = d[key];
      // Stale draft (live base moved underneath it) starts over.
      const bits = entry && entry.base === base ? entry.bits : base;
      return { ...d, [key]: { base, bits: bits ^ bit } };
    });
  }

  function dropDraft(key: string) {
    setDrafts((d) => {
      const { [key]: _removed, ...rest } = d;
      return rest;
    });
  }

  const cfg = config.data;
  const atCap = (cfg?.keepers.length ?? 0) >= MAX_APPROVED_KEEPERS;
  const addBits = drafts['']?.bits ?? 0;
  const addValid = ADDRESS_RE.test(addressInput) && addBits !== 0 && !atCap;

  return (
    <section className="card">
      <div className="card-title">
        <Bot aria-hidden />
        <h2 style={{ margin: 0 }}>{copy.keepers.title}</h2>
      </div>
      <p className="muted">{copy.keepers.blurb}</p>
      <p className="muted">{copy.keepers.safetyNote}</p>

      {!address ? (
        <p className="muted">{copy.wallet.connectFirst}</p>
      ) : config.isError && !cfg ? (
        <p className="muted">{copy.keepers.unavailable}</p>
      ) : !cfg ? (
        <p className="muted">{copy.keepers.loading}</p>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {config.isError ? (
            // A failed BACKGROUND refetch must never replace the
            // manager (revoke has to stay reachable during degraded
            // RPC) — flag the retained data as possibly stale instead.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">{copy.keepers.staleWarning}</span>
            </div>
          ) : null}
          <label className="cluster" style={{ alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={cfg.enabled}
              disabled={busy || !walletReady}
              onChange={(e) =>
                void run(async () => {
                  await write('setKeeperAccess', [e.target.checked]);
                }, e.target.checked ? copy.keepers.enabledOn : copy.keepers.enabledOff)
              }
            />
            <span>{copy.keepers.masterLabel}</span>
          </label>

          {cfg.keepers.map((entry) => {
            const key = entry.keeper.toLowerCase();
            const unreadable = entry.actions === null;
            const base = entry.actions ?? 0;
            const draft = drafts[key];
            // A draft based on an older mask is dead — render live.
            const bits = draft && draft.base === base ? draft.bits : base;
            const dirty = bits !== base;
            return (
              <div key={key} className="card" style={{ padding: 12 }}>
                <div className="spread">
                  <strong>{shortAddress(entry.keeper)}</strong>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy || !walletReady}
                    onClick={() =>
                      void run(async () => {
                        await write('revokeKeeper', [entry.keeper]);
                        // An abandoned edit must not resurrect onto a
                        // future re-approval of the same address.
                        dropDraft(key);
                      }, copy.keepers.revoked)
                    }
                  >
                    {copy.keepers.revoke}
                  </button>
                </div>
                {unreadable ? (
                  // #625 lesson: never offer edits over a failed read.
                  <p className="muted" style={{ marginTop: 8 }}>
                    {copy.keepers.maskUnreadable}
                  </p>
                ) : (
                  <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                    <ActionChecklist
                      bits={bits}
                      disabled={busy || !walletReady}
                      onToggle={(bit) => toggleDraft(key, bit, base)}
                    />
                    {(base & ~EXPOSED_ACTIONS_MASK) !== 0 ? (
                      <p className="muted">{copy.keepers.extraBitsNote}</p>
                    ) : null}
                    {dirty ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy || !walletReady}
                        onClick={() =>
                          void run(async () => {
                            // Preserve any bits outside the exposed
                            // set — REPLACE semantics must not strip
                            // permissions this UI doesn't render.
                            const outside = base & ~EXPOSED_ACTIONS_MASK;
                            const next = (bits & EXPOSED_ACTIONS_MASK) | outside;
                            if (next === 0) {
                              await write('revokeKeeper', [entry.keeper]);
                            } else {
                              await write('setKeeperActions', [entry.keeper, next]);
                            }
                            dropDraft(key);
                          }, copy.keepers.updated)
                        }
                      >
                        {copy.keepers.save}
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}

          {atCap ? (
            <p className="muted">{copy.keepers.atCap(MAX_APPROVED_KEEPERS)}</p>
          ) : (
            <div className="card" style={{ padding: 12 }}>
              <strong>{copy.keepers.addTitle}</strong>
              <input
                className="input"
                style={{ marginTop: 8 }}
                placeholder={copy.keepers.addressPlaceholder}
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value.trim())}
                aria-label={copy.keepers.addTitle}
              />
              <div style={{ marginTop: 8 }}>
                <ActionChecklist
                  bits={addBits}
                  disabled={busy || !walletReady}
                  onToggle={(bit) => toggleDraft('', bit, 0)}
                />
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginTop: 8 }}
                disabled={busy || !walletReady || !addValid}
                onClick={() =>
                  void run(async () => {
                    // Already-listed keepers must go through the
                    // update path (approveKeeper reverts on them).
                    const exists = cfg.keepers.some(
                      (k) => k.keeper.toLowerCase() === addressInput.toLowerCase(),
                    );
                    if (exists) throw new Error(copy.keepers.alreadyListed);
                    await write('approveKeeper', [
                      addressInput as `0x${string}`,
                      addBits,
                    ]);
                    setAddressInput('');
                    dropDraft('');
                  }, copy.keepers.added)
                }
              >
                {copy.keepers.add}
              </button>
              <p className="muted" style={{ marginTop: 8 }}>
                {copy.keepers.perLoanReminder}
              </p>
            </div>
          )}
        </div>
      )}

      {done ? (
        <div className="banner banner-info" role="status" style={{ marginTop: 12 }}>
          <span className="banner-body">{done}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}
