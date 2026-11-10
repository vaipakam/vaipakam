import { encodeEventTopics, encodeAbiParameters, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { PROTECTED } from './safety';
import { measureSigner, nomineeState, signerBlockers, signerCall, type SignerFacts, type SignerMode, type SignerReview } from './signers';

type Hex = `0x${string}`;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const SIGNER = '0x00000000000000000000000000000000000000a5' as Hex;
const OTHER = '0x00000000000000000000000000000000000000a6' as Hex;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const DAY = 86_400;
const NOW = 1_800_000_000;

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}:${JSON.stringify(v)}`,
};

const ON: SignerMode = {
  enabled: true,
  locked: false,
  retired: false,
  requireCosign: false,
  pendingCosignOffAt: 0,
  delaySeconds: 2 * DAY,
  cooldownUntil: 0,
  controller: '0x0000000000000000000000000000000000000000',
};

function facts(over: Partial<SignerFacts> = {}): SignerFacts {
  return { account: ME, mode: ON, signers: [], pending: [], paused: false, chainNow: NOW, readAt: Date.now(), ...over };
}

function review(action: SignerReview['action'], over: Partial<SignerFacts> = {}, signer: Hex = SIGNER): SignerReview {
  return { identity: 'me', action, signer, facts: facts(over), dryRun: null, readAt: Date.now() };
}

const first = (r: SignerReview) => signerBlockers(r, copy)[0] ?? null;

describe('nomineeState', () => {
  it('waits before maturity, is ready for one further delay, then lapses', () => {
    const p = { signer: SIGNER, maturesAt: NOW, accepted: false };
    expect(nomineeState(p, DAY, NOW - 1)).toBe('waiting');
    expect(nomineeState(p, DAY, NOW + DAY)).toBe('ready');
    expect(nomineeState(p, DAY, NOW + DAY + 1)).toBe('expired');
  });
});

describe('signerCall', () => {
  it('names the facet entry and its arguments for each action', () => {
    expect(signerCall('add', ME, SIGNER)).toMatchObject({ functionName: 'addSigner', args: [ME, SIGNER] });
    expect(signerCall('accept', ME, SIGNER)).toMatchObject({ functionName: 'acceptSignerRole', args: [ME] });
    expect(signerCall('applyAdd', ME, SIGNER).functionName).toBe('finalizeAddSigner');
    expect(signerCall('remove', ME, SIGNER).functionName).toBe('requestRemoveSigner');
    expect(signerCall('applyRemove', ME, SIGNER).functionName).toBe('finalizeRemoveSigner');
    expect(signerCall('cosignOn', ME, ME)).toMatchObject({ functionName: 'setRequireCosign', args: [ME, true] });
    expect(signerCall('cosignOff', ME, ME)).toMatchObject({ functionName: 'setRequireCosign', args: [ME, false] });
  });
});

describe('signerBlockers', () => {
  it('lets a saved wallet be asked, and refuses itself, a signer, a waiting or lapsed request and a full account', () => {
    expect(first(review('add'))).toBeNull();
    expect(first(review('add', {}, ME))).toBe('signer.isSelf');
    expect(first(review('add', { signers: [{ signer: SIGNER, removeAt: 0 }] }))).toBe('signer.alreadySigner');
    expect(first(review('add', { pending: [{ signer: SIGNER, maturesAt: NOW + DAY, accepted: false }] }))).toMatch(/^signer.alreadyWaiting/);
    // A lapsed request still blocks a new one until it is cancelled.
    expect(first(review('add', { pending: [{ signer: SIGNER, maturesAt: NOW - 5 * DAY, accepted: false }] }))).toBe('signer.lapsedCancelFirst');
    const five = Array.from({ length: 5 }, (_, i) => ({ signer: `0x${String(i + 1).padStart(40, '0')}` as Hex, removeAt: 0 }));
    expect(first(review('add', { signers: five }))).toMatch(/^signer.full/);
  });

  it('closes loosening changes while locked, in a cool-down and during a pause, but keeps cancelling open', () => {
    expect(first(review('add', { mode: { ...ON, locked: true } }))).toBe('signer.locked');
    expect(first(review('remove', { signers: [{ signer: SIGNER, removeAt: 0 }], mode: { ...ON, cooldownUntil: NOW + DAY } }))).toMatch(/^safety.cooldown/);
    expect(first(review('add', { paused: true }))).toBe('signer.paused');
    expect(first(review('cancelAdd', { paused: true, pending: [{ signer: SIGNER, maturesAt: NOW, accepted: false }] }))).toBeNull();
  });

  it('makes a wallet a signer only after its wait, within the window, once it accepted', () => {
    const p = (maturesAt: number, accepted: boolean) => ({ pending: [{ signer: SIGNER, maturesAt, accepted }] });
    expect(first(review('applyAdd', p(NOW + DAY, true)))).toMatch(/^signer.notYet/);
    expect(first(review('applyAdd', p(NOW - DAY, false)))).toBe('signer.notAccepted');
    expect(first(review('applyAdd', p(NOW - 3 * DAY, true)))).toMatch(/^signer.expired/);
    expect(first(review('applyAdd', p(NOW - DAY, true)))).toBeNull();
  });

  it('lets only the asked wallet accept, once', () => {
    expect(first(review('accept', { pending: [] }))).toBe('signer.notNominated');
    expect(first(review('accept', { pending: [{ signer: SIGNER, maturesAt: NOW + DAY, accepted: true }] }))).toBe('signer.alreadyAccepted');
    expect(first(review('accept', { pending: [{ signer: SIGNER, maturesAt: NOW + DAY, accepted: false }] }))).toBeNull();
  });

  it('removes a signer only after its own wait', () => {
    expect(first(review('remove', { signers: [{ signer: OTHER, removeAt: 0 }] }))).toBe('signer.notSigner');
    expect(first(review('remove', { signers: [{ signer: SIGNER, removeAt: NOW + DAY }] }))).toMatch(/^signer.alreadyRemoving/);
    expect(first(review('applyRemove', { signers: [{ signer: SIGNER, removeAt: NOW + DAY }] }))).toMatch(/^signer.removeNotYet/);
    expect(first(review('applyRemove', { signers: [{ signer: SIGNER, removeAt: NOW - 1 }] }))).toBeNull();
    expect(first(review('cancelRemove', { signers: [{ signer: SIGNER, removeAt: 0 }] }))).toBe('signer.notRemoving');
  });

  it('requires a co-sign only with a signer, and switches it off only once', () => {
    expect(first(review('cosignOn', {}, ME))).toBe('signer.cosignNeedsSigner');
    expect(first(review('cosignOn', { signers: [{ signer: SIGNER, removeAt: 0 }] }, ME))).toBeNull();
    expect(first(review('cosignOff', {}, ME))).toBe('signer.cosignAlreadyOff');
    expect(first(review('cosignOff', { mode: { ...ON, requireCosign: true, pendingCosignOffAt: NOW + DAY } }, ME))).toMatch(/^signer.cosignOffAsked/);
    // Asking again to require it while a switch-off waits keeps it on.
    expect(
      first(review('cosignOn', { signers: [{ signer: SIGNER, removeAt: 0 }], mode: { ...ON, requireCosign: true, pendingCosignOffAt: NOW + DAY } }, ME)),
    ).toBeNull();
  });

  it('refuses everything when protected mode is off or the feature is absent', () => {
    expect(first(review('add', { mode: { ...ON, enabled: false } }))).toBe('signer.modeOff');
    expect(first(review('add', { mode: 'absent' }))).toBe('safety.unavailable');
  });

  it('keeps a retired account’s nominee able to accept, and its original wallet from managing', () => {
    const retired = { mode: { ...ON, retired: true }, pending: [{ signer: SIGNER, maturesAt: NOW + DAY, accepted: false }] };
    expect(first(review('accept', retired))).toBeNull();
    expect(first(review('add', { mode: { ...ON, retired: true } }, OTHER))).toBe('safety.retired');
  });
});

describe('measureSigner', () => {
  const log = (eventName: string, args: Record<string, unknown>, data: Hex = '0x'): Log =>
    ({ address: DIAMOND, topics: encodeEventTopics({ abi: PROTECTED, eventName, args } as never), data }) as unknown as Log;

  it('reads what the transaction recorded for this account and signer', () => {
    const at = BigInt(NOW + DAY);
    const asked = log('SignerAddRequested', { account: ME, signer: SIGNER }, encodeAbiParameters([{ type: 'uint256' }], [at]));
    expect(measureSigner(review('add'), [asked], DIAMOND, copy)[0]).toMatchObject({ status: 'done' });
    const elsewhere = log('SignerAddRequested', { account: ME, signer: OTHER }, encodeAbiParameters([{ type: 'uint256' }], [at]));
    expect(measureSigner(review('add'), [elsewhere], DIAMOND, copy)[0]).toMatchObject({ status: 'not-done' });
  });

  it('states that removing the last signer also stopped the co-sign', () => {
    const removed = log('SignerRemoved', { account: ME, signer: SIGNER });
    const off = log('CosignRequirementSet', { account: ME }, encodeAbiParameters([{ type: 'bool' }], [false]));
    expect(measureSigner(review('applyRemove'), [removed, off], DIAMOND, copy).map((l) => l.label)).toEqual([
      `signer.legRemoved:${JSON.stringify({ signer: SIGNER })}`,
      'signer.legCosignOff',
    ]);
  });
});
