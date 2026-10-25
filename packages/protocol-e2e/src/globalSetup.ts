/**
 * Vitest global setup: build both chains and the lane between them once per
 * run (`fixture.ts`). Set `PROTOCOL_E2E_REUSE_FIXTURE=1` to keep a
 * `.state/mesh/` an earlier run built — an inner-loop convenience only; CI
 * always builds afresh. The build writes its completion marker last, so reuse
 * never starts from a half-built fixture.
 */
import { prepareProtocolMesh, protocolMesh } from './fixture';

export default async function setup(): Promise<void> {
  if (process.env.PROTOCOL_E2E_REUSE_FIXTURE === '1' && protocolMesh.isBuilt()) {
    console.log('[protocol-e2e mesh] reusing the fixture under .state/mesh/ (PROTOCOL_E2E_REUSE_FIXTURE=1)');
    return;
  }
  await prepareProtocolMesh();
}
