/**
 * The fork relay's selection rules (#3892): it delivers only messages the
 * source on-ramp emitted, refuses a message whose id is not its own hash, and
 * refuses any ramp version it was not built for. The delivery itself (gas
 * limit applied, a failed receiver failing the step) is held by the
 * stand-in's forge suite, `contracts/test/RehearsalOffRampTest.t.sol`.
 */
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { chooseOffRamp, FORK_RELAY_LIMITS, OFF_RAMP_VERSION, ON_RAMP_VERSION, requireVersion, selectSentMessages } from './forkRelay';

// The deployed OnRamp 2.0.0 event, written out here so the test does not
// need a forge build; the relay itself reads the compiled declaration.
const ON_RAMP_ABI = parseAbi([
  'struct Receipt { address issuer; uint32 destGasLimit; uint32 destBytesOverhead; uint256 feeTokenAmount; bytes extraArgs; }',
  'event CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId, address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, Receipt[] receipts, bytes[] verifierBlobs)',
]);

const ON_RAMP = '0xA33b221A8427739c76f631a995ca60544bEdD632' as Address;
const OTHER = '0x00000000000000000000000000000000000000aa' as Address;
const SENDER = '0x00000000000000000000000000000000000000b0' as Address;
const FEE_TOKEN = '0x00000000000000000000000000000000000000fe' as Address;
const ARB = 3478487238524512106n;
const BNB = 13264668187771770619n;

function sentLog(opts: { address?: Address; dest?: bigint; encoded?: Hex; id?: Hex; tx?: Hex }) {
  const encoded = opts.encoded ?? ('0x01c0ffee' as Hex);
  const messageId = opts.id ?? keccak256(encoded);
  const topics = encodeEventTopics({
    abi: ON_RAMP_ABI,
    eventName: 'CCIPMessageSent',
    args: { destChainSelector: opts.dest ?? ARB, sender: SENDER, messageId },
  });
  const data = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'bytes' },
      {
        type: 'tuple[]',
        components: [
          { name: 'issuer', type: 'address' },
          { name: 'destGasLimit', type: 'uint32' },
          { name: 'destBytesOverhead', type: 'uint32' },
          { name: 'feeTokenAmount', type: 'uint256' },
          { name: 'extraArgs', type: 'bytes' },
        ],
      },
      { type: 'bytes[]' },
    ],
    [
      FEE_TOKEN,
      7n,
      encoded,
      [
        { issuer: OTHER, destGasLimit: 1, destBytesOverhead: 2, feeTokenAmount: 10n, extraArgs: '0x' },
        { issuer: OTHER, destGasLimit: 3, destBytesOverhead: 4, feeTokenAmount: 5n, extraArgs: '0x' },
      ],
      [],
    ],
  );
  return { address: opts.address ?? ON_RAMP, topics: topics as never, data, transactionHash: opts.tx ?? ('0x' + '11'.repeat(32)) as Hex };
}

describe('selectSentMessages', () => {
  it('takes the on-ramp’s messages toward the destination, as emitted', () => {
    const got = selectSentMessages([sentLog({ encoded: '0x01abcd' })], ON_RAMP, ARB, ON_RAMP_ABI);
    expect(got).toHaveLength(1);
    expect(got[0]!.encodedMessage).toBe('0x01abcd');
    expect(got[0]!.messageId).toBe(keccak256('0x01abcd'));
    expect(got[0]!.feeToken.toLowerCase()).toBe(FEE_TOKEN);
    expect(got[0]!.receipts.reduce((s, r) => s + r.feeTokenAmount, 0n)).toBe(15n);
    expect(got[0]!.tokenAmountBeforeTokenPoolFees).toBe(7n);
  });

  it('ignores the same event from any other contract', () => {
    expect(selectSentMessages([sentLog({ address: OTHER })], ON_RAMP, ARB, ON_RAMP_ABI)).toEqual([]);
  });

  it('ignores messages toward another destination', () => {
    expect(selectSentMessages([sentLog({ dest: BNB })], ON_RAMP, ARB, ON_RAMP_ABI)).toEqual([]);
  });

  it('ignores logs that are not the message event', () => {
    const log = { ...sentLog({}), topics: [('0x' + '22'.repeat(32)) as Hex] as never };
    expect(selectSentMessages([log], ON_RAMP, ARB, ON_RAMP_ABI)).toEqual([]);
  });

  it('refuses a message whose id is not the hash of its bytes', () => {
    const log = sentLog({ encoded: '0x01abcd', id: ('0x' + '33'.repeat(32)) as Hex });
    expect(() => selectSentMessages([log], ON_RAMP, ARB, ON_RAMP_ABI)).toThrow(/not the hash of its own bytes/);
  });
});

describe('chooseOffRamp', () => {
  const v2 = '0xa137536A3BFd81aD6f090981268b8C2818451d41' as Address;
  const v16 = '0x0000000000000000000000000000000000000016' as Address;
  const v15 = '0x0000000000000000000000000000000000000015' as Address;

  it('picks the one 2.0.0 off-ramp and reports the older ones', () => {
    const versions = new Map([
      [v2.toLowerCase(), OFF_RAMP_VERSION],
      [v16.toLowerCase(), 'OffRamp 1.6.0'],
      [v15.toLowerCase(), 'EVM2EVMOffRamp 1.5.0'],
    ]);
    const { offRamp, others } = chooseOffRamp([v16, v2, v15], versions, 'a -> b');
    expect(offRamp).toBe(v2);
    expect(others).toEqual([
      { address: v16, version: 'OffRamp 1.6.0' },
      { address: v15, version: 'EVM2EVMOffRamp 1.5.0' },
    ]);
  });

  it('refuses a lane with no 2.0.0 off-ramp, naming what it found', () => {
    const versions = new Map([[v16.toLowerCase(), 'OffRamp 1.6.0']]);
    expect(() => chooseOffRamp([v16], versions, 'a -> b')).toThrow(/0 'OffRamp 2.0.0'.*OffRamp 1.6.0/);
  });

  it('refuses a lane with two 2.0.0 off-ramps', () => {
    const versions = new Map([
      [v2.toLowerCase(), OFF_RAMP_VERSION],
      [v16.toLowerCase(), OFF_RAMP_VERSION],
    ]);
    expect(() => chooseOffRamp([v2, v16], versions, 'a -> b')).toThrow(/2 'OffRamp 2.0.0'/);
  });
});

describe('requireVersion', () => {
  it('accepts the version it was built for and refuses any other by name', () => {
    expect(() => requireVersion(ON_RAMP_VERSION, ON_RAMP_VERSION, 'the on-ramp')).not.toThrow();
    expect(() => requireVersion('OnRamp 2.1.0', ON_RAMP_VERSION, 'the on-ramp')).toThrow(/reports 'OnRamp 2.1.0', not 'OnRamp 2.0.0'/);
  });
});

describe('FORK_RELAY_LIMITS', () => {
  it('states what the rehearsal does not exercise', () => {
    const text = FORK_RELAY_LIMITS.join(' ');
    expect(text).toMatch(/verification is not rehearsed/);
    expect(text).toMatch(/delays are not rehearsed/);
    expect(text).toMatch(/Manual execution is not rehearsed/);
  });
});
