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
import { submitErrorText } from '../lib/errors';
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
  // add-new form.
  const [draftBits, setDraftBits] = useState<Record<string, number>>({});

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient) && Boolean(address);

  async function run(fn: () => Promise<void>, doneMsg: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(doneMsg);
      void queryClient.invalidateQueries({ queryKey: ['keeperConfig'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleDraft(key: string, bit: number, base: number) {
    setDraftBits((d) => {
      const current = d[key] ?? base;
      return { ...d, [key]: current ^ bit };
    });
  }

  const cfg = config.data;
  const atCap = (cfg?.keepers.length ?? 0) >= MAX_APPROVED_KEEPERS;
  const addBits = draftBits[''] ?? 0;
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
      ) : config.isError ? (
        <p className="muted">{copy.keepers.unavailable}</p>
      ) : !cfg ? (
        <p className="muted">{copy.keepers.loading}</p>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
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
            const bits = draftBits[key] ?? base;
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
                    {KEEPER_ACTIONS.map((a) => (
                      <label key={a.bit} className="cluster" style={{ alignItems: 'flex-start' }}>
                        <input
                          type="checkbox"
                          checked={(bits & a.bit) !== 0}
                          disabled={busy || !walletReady}
                          onChange={() => toggleDraft(key, a.bit, base)}
                          style={{ marginTop: 3 }}
                        />
                        <span>
                          {a.label}{' '}
                          <span className="muted">({a.side}) — {a.blurb}</span>
                        </span>
                      </label>
                    ))}
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
                            setDraftBits((d) => {
                              const { [key]: _drop, ...rest } = d;
                              return rest;
                            });
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
                placeholder="0x… keeper address"
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value.trim())}
                aria-label={copy.keepers.addTitle}
              />
              <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                {KEEPER_ACTIONS.map((a) => (
                  <label key={a.bit} className="cluster" style={{ alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={(addBits & a.bit) !== 0}
                      disabled={busy || !walletReady}
                      onChange={() => toggleDraft('', a.bit, 0)}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      {a.label}{' '}
                      <span className="muted">({a.side}) — {a.blurb}</span>
                    </span>
                  </label>
                ))}
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
                    setDraftBits((d) => {
                      const { ['']: _drop, ...rest } = d;
                      return rest;
                    });
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
