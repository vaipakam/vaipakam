# Clear-signing descriptors (ERC-7730)

What a wallet or hardware device shows when a person signs a Vaipakam call or
message: the action in words, assets by name, amounts in units, rates as
percentages, terms in days and each acknowledgement flag spelled out, instead
of raw data (#3348, #3718 step 1).

| Path | What it is |
| --- | --- |
| `scope.json` | Every non-view Diamond function with its class: `user`, `upkeep`, `admin` or `internal`. Only `user` functions get a display. |
| `display.mjs` | The display rules: one intent per user call, field rules per call, per struct and per input name, and the EIP-712 messages. |
| `erc7730-v2.schema.json` | The ERC-7730 v2.1.0 JSON schema, vendored from the EIP assets (CC0), used to validate every descriptor. |
| `descriptors/` | GENERATED. Do not edit; run the build. |

```bash
node packages/contracts/scripts/build-clear-signing.mjs          # rebuild descriptors/
node packages/contracts/scripts/build-clear-signing.mjs --check  # fail if stale
```

`pnpm --filter @vaipakam/contracts test` (in CI) fails when the committed
descriptors differ from a fresh build. `exportFrontendAbis.sh` and
`exportFrontendDeployments.sh` rebuild them after every export.

## When you change the contracts

- **A new non-view function on any facet** must be named in `scope.json`.
  There are no facet-wide defaults: one hid two user calls in an admin facet
  while this was first written.
- **A new user function** needs an intent in `display.mjs` `CALLS`, and every
  one of its inputs needs a rule. Hiding an input takes a stated reason.
- **An enum, a constant-coded choice or an EIP-712 type string** is read from
  the Solidity source, so a change there shows up as a stale descriptor (or a
  refusal naming the label that no longer matches).

## What the descriptors cannot say

- An amount a call does not tie to a token address (most calls that take only
  a loan or offer id) is labelled "(smallest units)" of its asset rather than
  formatted as if the wallet knew the token.
- The vault-protection messages are signed to each person's own vault, so their
  descriptor binds the domain name only, not an address.
- Direct calls to a person's vault (the no-signature route of protected mode,
  through the vault's `protect(bytes)` entry) are not described yet; see the
  issue linked from the release note.

## Publishing

Submitting these files to the public registries wallets read (for example the
Ledger clear-signing registry) is an owner step and is not automated here.
