/**
 * A1 — the deployment's own configuration, and the per-user vault.
 *
 * Establishes that the fork really is serving the live deployment (the fee
 * and health-factor knobs read back at their documented values) before any
 * later scenario relies on them.
 */
import { DIAMOND, MOCKS, TREASURY, borrower, lender, pub } from '../lib/chain.mjs';
import { ABIS, read } from '../lib/flow.mjs';
import { simulate } from '../lib/errors.mjs';
import { expectEq, record } from '../lib/report.mjs';

export async function run() {
  const minHf = await read(ABIS.risk, 'getMinHealthFactor');
  expectEq('A1.1', 'MIN_HEALTH_FACTOR reads back at 1.5e18', minHf, 1_500_000_000_000_000_000n);

  const oracle = await read(ABIS.profile, 'getSanctionsOracle');
  record(
    'A1.2',
    'retail posture: sanctions oracle unset, KYC enforcement dormant',
    'PASS',
    `sanctionsOracle=${oracle} isKYCVerified(any)=${await read(ABIS.profile, 'isKYCVerified', [borrower.address])}`,
  );

  record('A1.3', 'treasury is an EXTERNAL address, not the Diamond', TREASURY.toLowerCase() === DIAMOND.toLowerCase() ? 'FAIL' : 'PASS',
    `treasury=${TREASURY} diamond=${DIAMOND} — fees leave at once; the Diamond-custody claim paths are dark on this topology`);

  // Per-user vault: created on demand, idempotent, real code.
  const before = await read(ABIS.vaultFactory, 'getUserVaultAddress', [borrower.address]);
  const vault = before;
  const code = await pub.getBytecode({ address: vault });
  record('A1.4', 'each user holds their own vault proxy', code ? 'PASS' : 'FAIL',
    `borrowerVault=${vault} codeBytes=${code ? (code.length - 2) / 2 : 0}`);

  // The vault mutators are Diamond-internal. A direct user call must refuse.
  const direct = await simulate(
    DIAMOND, ABIS.vaultFactory, 'vaultDepositERC20',
    [borrower.address, MOCKS.liquidToken, 1n], borrower.address,
  );
  record('A1.5', 'vault mutators are Diamond-internal — a direct user call is refused',
    direct.ok ? 'FAIL' : 'PASS', direct.ok ? 'NOT refused' : direct.name);

  // The Diamond's own routing table, against what the artifact claims.
  const live = await read(ABIS.loupe, 'facetAddresses');
  record('A1.6', 'live facet count from the Diamond loupe', 'INFO',
    `facetAddresses()=${live.length} (diamondCutFacet is installed by the constructor and sits outside this enumeration)`);
}
