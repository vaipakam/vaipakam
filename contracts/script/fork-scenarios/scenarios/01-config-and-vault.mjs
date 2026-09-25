/**
 * A1 — the deployment's own configuration, and the per-user vault.
 *
 * Establishes that the fork really is serving the live deployment (the fee
 * and health-factor knobs read back at their documented values) before any
 * later scenario relies on them.
 */
import { ADMIN, ARTIFACT_ADMIN, ARTIFACT_TREASURY, DIAMOND, MOCKS, TREASURY, borrower, f18, lender, pub } from '../lib/chain.mjs';
import { ABIS, read, vaultAddressFor } from '../lib/flow.mjs';
import { simulate } from '../lib/errors.mjs';
import { check, expectEq, observe, expectRefusal } from '../lib/report.mjs';

export async function run() {
  const minHf = await read(ABIS.risk, 'getMinHealthFactor');
  // Governance-tunable within the spec's bounded range [1.2, 2.0] (default
  // 1.5), so the value is asserted against the range, not a fixed number.
  check('A1.1', 'the loan-admission health-factor floor is inside the spec\'s governed range [1.2, 2.0]',
    minHf >= 1_200_000_000_000_000_000n && minHf <= 2_000_000_000_000_000_000n, `getMinHealthFactor=${f18(minHf)}`);

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

  // Topology is configuration: Diamond-as-treasury is a supported mode. The
  // runner refuses to run the ledgers on it (they are written for an external
  // treasury), so by the time this row runs the topology is external — and it
  // is recorded, not certified.
  observe('A1.3', 'treasury topology',
    `treasury(live getTreasury)=${TREASURY} diamond=${DIAMOND} — EXTERNAL: fees leave at once; the Diamond-custody claim paths are dark on this topology`);
  // The treasury is mutable; the artifact records only its deploy-time value.
  // Every accounting row uses the LIVE value, so a drifted artifact is shown,
  // not silently trusted.
  observe('A1.3b', 'the deployment artifact\'s treasury against the live one',
    ARTIFACT_TREASURY.toLowerCase() === TREASURY.toLowerCase() ? `match (${TREASURY})` : `DRIFT: artifact=${ARTIFACT_TREASURY} live=${TREASURY}`);
  // Same for the admin: the gate scenarios act through whoever holds
  // ADMIN_ROLE on the live Diamond, resolved at start-up, not the artifact.
  observe('A1.3c', 'the deployment artifact\'s admin against the live ADMIN_ROLE holder',
    ARTIFACT_ADMIN.toLowerCase() === ADMIN.toLowerCase() ? `match (${ADMIN})` : `DRIFT: artifact=${ARTIFACT_ADMIN} live=${ADMIN}`);

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
  expectRefusal('A1.5', 'vault mutators are Diamond-internal — a direct user call is refused', direct, 'OnlyDiamondInternal');

  // The Diamond's own routing table, against what the artifact claims.
  const live = await read(ABIS.loupe, 'facetAddresses');
  observe('A1.6', 'live facet count from the Diamond loupe',
    `facetAddresses()=${live.length} (diamondCutFacet is installed by the constructor and sits outside this enumeration)`);
}
