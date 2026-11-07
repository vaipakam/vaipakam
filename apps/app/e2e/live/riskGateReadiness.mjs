/**
 * Whether the risk-access gate lets the parties of a live drive transact
 * the pair the drive is about to write (#671, #3231).
 *
 * The signing drives (`live-seed-illiquid-loan.mjs`, `live-refinance.mjs`)
 * used to BLOCK whenever the gate was on, because their write plans carry no
 * tier or pair-consent step. Since 2026-11-06 the gate is on on every
 * testnet, which left both drives permanently blocked. A drive does not need
 * the gate OFF; it needs every gated party to be ALREADY allowed, so the
 * plan never has to write a tier or a consent. That is what this module
 * decides, from the chain, before anything is written:
 *
 *   - before the first write (no offer exists yet), per party and from the
 *     pair: the party's EFFECTIVE tier covers the pair's required level, an
 *     illiquid pair has an ARMED standing consent (set, version-current and
 *     past its arming cooldown — `hasIlliquidPairConsent`), and no strict-mode
 *     mid-tier acknowledgement is missing (`midTierStrictBlocked`);
 *   - once the request exists, right before the acceptor is armed: the
 *     contract's own previews, `previewCreatorBlock(offerId)` and
 *     `previewOfferAcceptBlock(offerId, acceptor)`, both 0. Those are the
 *     exact rule the accept enforces, so a drive cannot pass this check and
 *     then be refused by the gate.
 *
 * The drive never writes a tier or a consent. A party that is not ready is a
 * BLOCKED precondition with the reason named, never a FAIL.
 */

/** The tiers, in the contract's `RiskAccessLevel` order. */
export const RISK_LEVELS = Object.freeze(['BlueChipOnly', 'BroadLiquid', 'IlliquidCustom']);

/** `previewOfferAcceptBlock` / `previewCreatorBlock` codes (RiskPreviewFacet). */
export const GATE_BLOCK_REASONS = Object.freeze({
  0: 'allowed',
  1: 'tier too low for the pair',
  2: 'illiquid pair needs an armed standing consent',
  3: 'strict mode: the mid-tier pair needs an explicit acknowledgement',
});

const levelName = (n) => RISK_LEVELS[Number(n)] ?? `level ${n}`;

/**
 * The pure decision before any offer exists.
 *
 * @param {{ gateEnabled: boolean, required: number|bigint,
 *           parties: { label: string, tier: number|bigint, consent: boolean, strictBlocked: boolean }[] }} input
 * @returns {{ ok: boolean, lines: { label: string, ok: boolean, observed: string }[] }}
 */
export function judgeRiskGateParties({ gateEnabled, required, parties }) {
  if (gateEnabled === false) {
    return { ok: true, lines: [{ label: 'risk-access gate off: no party is gated', ok: true, observed: 'false' }] };
  }
  if (gateEnabled !== true) {
    return { ok: false, lines: [{ label: 'risk-access gate state is readable', ok: false, observed: String(gateEnabled) }] };
  }
  const need = Number(required);
  const lines = [];
  for (const p of parties) {
    const tier = Number(p.tier);
    const reasons = [];
    if (!(tier >= need)) reasons.push(`effective tier ${levelName(tier)} is below the pair's ${levelName(need)}`);
    if (need >= 2 && p.consent !== true) reasons.push('no armed standing consent for this illiquid pair');
    if (p.strictBlocked === true) reasons.push('strict mode needs a mid-tier acknowledgement');
    lines.push({
      label: `${p.label} may transact the pair under the gate (needs ${levelName(need)})`,
      ok: reasons.length === 0,
      observed: reasons.length ? reasons.join('; ') : `tier ${levelName(tier)}${need >= 2 ? ', consent armed' : ''}`,
    });
  }
  return { ok: lines.every((l) => l.ok), lines };
}

/**
 * Read what {judgeRiskGateParties} needs, at one block.
 *
 * @param {(fn: string, args: any[], blockNumber?: bigint) => Promise<any>} read  the drive's Diamond reader
 * @param {{ gateEnabled: boolean, pair: object, parties: { label: string, address: string }[], blockNumber?: bigint }} ctx
 *        `gateEnabled` comes from the drive's watched-config snapshot, never read here.
 */
export async function readRiskGateParties(read, { gateEnabled, pair, parties, blockNumber }) {
  if (gateEnabled !== true) return judgeRiskGateParties({ gateEnabled, required: 0, parties: [] });
  const required = await read('pairRequiredRiskLevel', [pair], blockNumber);
  const rows = await Promise.all(
    parties.map(async (p) => {
      const [tier, consent, strictBlocked] = await Promise.all([
        read('getEffectiveRiskTier', [p.address], blockNumber),
        read('hasIlliquidPairConsent', [p.address, pair], blockNumber),
        read('midTierStrictBlocked', [p.address, pair], blockNumber),
      ]);
      return { label: p.label, tier, consent, strictBlocked };
    }),
  );
  return judgeRiskGateParties({ gateEnabled, required, parties: rows });
}

/**
 * The pure decision once the request exists: the contract's own previews.
 *
 * @param {{ gateEnabled: boolean, creatorCode: number|bigint, acceptorCode: number|bigint,
 *           creatorLabel: string, acceptorLabel: string, offerId: bigint|number }} input
 */
export function judgeOfferGate({ gateEnabled, creatorCode, acceptorCode, creatorLabel, acceptorLabel, offerId }) {
  if (gateEnabled === false) {
    return { ok: true, lines: [{ label: `risk-access gate off: offer #${offerId} is not gated`, ok: true, observed: 'false' }] };
  }
  const line = (who, code) => ({
    label: `${who} passes the accept gate for offer #${offerId} (preview code 0)`,
    ok: gateEnabled === true && Number(code) === 0,
    observed: `${code} (${GATE_BLOCK_REASONS[Number(code)] ?? 'unknown code'})`,
  });
  const lines = [line(creatorLabel, creatorCode), line(acceptorLabel, acceptorCode)];
  return { ok: lines.every((l) => l.ok), lines };
}

/** Read {judgeOfferGate}'s inputs at one block. */
export async function readOfferGate(read, { gateEnabled, offerId, acceptor, creatorLabel, acceptorLabel, blockNumber }) {
  if (gateEnabled !== true) return judgeOfferGate({ gateEnabled, offerId });
  const [creatorCode, acceptorCode] = await Promise.all([
    read('previewCreatorBlock', [offerId], blockNumber),
    read('previewOfferAcceptBlock', [offerId, acceptor], blockNumber),
  ]);
  return judgeOfferGate({ gateEnabled, creatorCode, acceptorCode, creatorLabel, acceptorLabel, offerId });
}

/** Every Diamond getter this module reads, for the snapshot's classification test. */
export const RISK_GATE_READS = Object.freeze([
  'pairRequiredRiskLevel',
  'getEffectiveRiskTier',
  'hasIlliquidPairConsent',
  'midTierStrictBlocked',
  'previewCreatorBlock',
  'previewOfferAcceptBlock',
]);
