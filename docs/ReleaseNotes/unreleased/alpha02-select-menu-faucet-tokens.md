# Asset pickers list the faucet test tokens, and every dropdown gets a real menu (alpha02)

Two changes from the same user request (2026-07-06):

- **On test networks, the borrow / lend / rent asset pickers now list
  the faucet's test tokens** (tLIQ, tLQ2, mWETH, tILQ, tILQ2) as
  first-class choices, each clearly badged as a faucet test token.
  Before this, the faucet page would mint them but the pickers made
  people paste the contract addresses back by hand — the exact
  address-hunting the curated-first picker exists to avoid. The
  addresses come from the same deployments source the faucet page
  reads, and the badge keeps them impossible to mistake for real
  assets. Chains without faucet tokens (all mainnets) are unchanged.

- **Every dropdown in the app is now a properly designed menu instead
  of the browser's built-in one.** The old dropdowns rendered the
  operating system's stock option list — visually flat, single-line
  only, and clashing with the app's light/dark themes. The new menu
  matches the app's look in both themes, supports a second line
  (asset rows show the contract address under the symbol) and badges,
  marks the current choice, and animates gently (respecting the
  reduced-motion preference). Keyboard behaviour matches the native
  control: arrows move, typing jumps to a match, Enter/Space picks,
  Escape closes — and screen readers get the standard combobox/
  listbox semantics.

Nothing about what the dropdowns DO changed: the same choices, the
same paste-an-address escape hatch on asset pickers, the same
selection behaviour everywhere.
