/**
 * Keeper action bitmask — the on-chain permission bits and the two grant
 * presets built from them.
 *
 * Split out of `pages/KeeperSettings.tsx` so that page exports a component
 * and nothing else; a module mixing a component with plain values makes
 * editing the page a full reload instead of a hot swap. These are protocol
 * constants with no React dependency, so `lib/` is where they belonged
 * anyway — the settings page is one of their callers, not their home.
 */

// Phase 6: action bitmask bits — must mirror LibVaipakam.KEEPER_ACTION_*.
// Adding a bit here without adding it on-chain yields an
// `InvalidKeeperActions` revert.
export const KEEPER_ACTION = {
  COMPLETE_LOAN_SALE: 0x01,
  COMPLETE_OFFSET: 0x02,
  INIT_EARLY_WITHDRAW: 0x04,
  INIT_PRECLOSE: 0x08,
  REFINANCE: 0x10,
  // T-092 Phase 3 (#503) — activated when KEEPER_ACTION_ALL widened
  // from 0x1F to 0x3F server-side. The dedicated toggle row below
  // lets users opt in or out per-action.
  EXTEND: 0x20,
  // #625 WI-1 (auto-lend) — the standing-intent delegation bits. On-chain
  // KEEPER_ACTION_ALL is 0xFF, so these are valid grants. Surfaced here so
  // a keeper delegated via the auto-lend card (which may hold only AUTO_ROLL
  // and/or SIGNED_FILL) shows those permissions instead of appearing blank.
  SIGNED_FILL: 0x40,
  AUTO_ROLL: 0x80,
} as const;
export const KEEPER_ACTION_ALL =
  KEEPER_ACTION.COMPLETE_LOAN_SALE |
  KEEPER_ACTION.COMPLETE_OFFSET |
  KEEPER_ACTION.INIT_EARLY_WITHDRAW |
  KEEPER_ACTION.INIT_PRECLOSE |
  KEEPER_ACTION.REFINANCE |
  KEEPER_ACTION.EXTEND |
  KEEPER_ACTION.SIGNED_FILL |
  KEEPER_ACTION.AUTO_ROLL;

// #625 WI-1 — default grant for the manual "Add keeper" flow EXCLUDES the
// auto-lend capital-deployment bits (SIGNED_FILL / AUTO_ROLL). Those let a
// keeper deploy standing-intent capital and re-lien repaid proceeds, so
// they must be granted deliberately — via the auto-lend card (which gates
// them behind an explicit acknowledgement) or by ticking their rows here —
// never handed out by leaving the default boxes checked for a keeper added
// for ordinary loan-management actions.
export const DEFAULT_KEEPER_ACTIONS =
  KEEPER_ACTION_ALL & ~(KEEPER_ACTION.SIGNED_FILL | KEEPER_ACTION.AUTO_ROLL);
