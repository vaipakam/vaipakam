/**
 * A1 — the deployment's own configuration, and the per-user vault.
 *
 * Establishes that the fork really is serving the live deployment (the fee
 * and health-factor knobs read back at their documented values) before any
 * later scenario relies on them.
 */
import { ARTIFACT_TREASURY, DIAMOND, MOCKS, TREASURY, borrower, lender, pub } from '../lib/chain.mjs';
import { ABIS, read, vaultAddressFor } from '../lib/flow.mjs';
import { simulate } from '../lib/errors.mjs';
import { check, expectEq, observe } from '../lib/report.mjs';

export async function run() {
  const minHf = await read(ABIS.risk, 'getMinHealthFactor');
  expectEq('A1.1', 'MIN_HEALTH_FACTOR reads back at 1.5e18', minHf, 1_500_000_000_000_000_000n);

  // The deployment's OPERATIONAL posture is configuration, not a protocol
  // property: the retail deploy is meant to wire a sanctions oracle once one
  // exists on-chain, and this testnet has not. So it is observed, with the
  // values, rather than certified — a later deploy that wires the oracle must
  // not keep reporting a green "unset".
  const oracle = await read(ABIS.profile, 'getSanctionsOracle');
  const kycShortCircuits = await read(ABIS.profile, 'isKYCVerified', [borrower.address]);
  observe('A1.2', 'operational posture: sanctions oracle and KYC enforcement',
    `sanctionsOracle=${oracle}${/^0x0{40}$/i.test(oracle) ? ' (unset)' : ''} ` +
    `isKYCVerified(fresh wallet)=${kycShortCircuits}${kycShortCircuits ? ' (enforcement dormant)' : ' (enforcement ARMED)'}`);

  check('A1.3', 'treasury is an EXTERNAL address, not the Diamond', TREASURY.toLowerCase() !== DIAMOND.toLowerCase(),
    `treasury(live getTreasury)=${TREASURY} diamond=${DIAMOND} — fees leave at once; the Diamond-custody claim paths are dark on this topology`);
  // The treasury is mutable; the artifact records only its deploy-time value.
  // Every accounting row uses the LIVE value, so a drifted artifact is shown,
  // not silently trusted.
  observe('A1.3b', 'the deployment artifact\'s treasury against the live one',
    ARTIFACT_TREASURY.toLowerCase() === TREASURY.toLowerCase() ? `match (${TREASURY})` : `DRIFT: artifact=${ARTIFACT_TREASURY} live=${TREASURY}`);

  // Per-user vault: created on demand, idempotent, real code. On a PRISTINE
  // fork neither role has one yet and `getUserVaultAddress` answers
  // `address(0)` without reverting, so this has to create before it reads.
  const unset = await read(ABIS.vaultFactory, 'getUserVaultAddress', [borrower.address]);
  const vault = await vaultAddressFor(borrower);
  const again = await vaultAddressFor(borrower);
  const code = await pub.getBytecode({ address: vault });
  check('A1.4', 'a vault is created on demand, is idempotent, and has code',
    Boolean(code) && code !== '0x' && vault === again,
    `beforeCreate=${unset} vault=${vault} secondCall=${again} codeBytes=${code ? (code.length - 2) / 2 : 0}`);

  // The vault mutators are Diamond-internal. A direct user call must refuse.
  const direct = await simulate(
    DIAMOND, ABIS.vaultFactory, 'vaultDepositERC20',
    [borrower.address, MOCKS.liquidToken, 1n], borrower.address,
  );
  check('A1.5', 'vault mutators are Diamond-internal — a direct user call is refused',
    !direct.ok, direct.ok ? 'NOT refused' : direct.name);

  // The Diamond's own routing table, against what the artifact claims.
  const live = await read(ABIS.loupe, 'facetAddresses');
  observe('A1.6', 'live facet count from the Diamond loupe',
    `facetAddresses()=${live.length} (diamondCutFacet is installed by the constructor and sits outside this enumeration)`);
}
