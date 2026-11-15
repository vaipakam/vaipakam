/**
 * ACC-25, ACC-26 — the adoption the app signs is the one the protocol
 * checks (the declaration's text, the EIP-712 type and digest), what stops
 * adopting and disowning is stated in order, and the outcome is read from
 * the transaction's own record.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, hashTypedData, keccak256, concat, toBytes, type Abi, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { VaultDepositoryFacetABI } from '@vaipakam/contracts/abis';
import { copy as catalogue } from '../../content/copy';
import {
  ADOPTION_ACK_HASH,
  ADOPTION_ACK_TEXT,
  ADOPTION_TYPES,
  adoptBlockers,
  adoptionDomain,
  adoptionMessage,
  adoptRecorded,
  adoptStops,
  disownRecorded,
  disownStops,
  type AdoptReview,
  type RecoverFacts,
} from './adopt';

type Hex = `0x${string}`;

const SOURCE = readFileSync(resolve(__dirname, '../../../../../contracts/src/facets/VaultDepositoryFacet.sol'), 'utf8');
const lookup = (key: string): string => {
  const [group, name] = key.split('.') as [string, string];
  const entry = (catalogue as unknown as Record<string, Record<string, { text: string }>>)[group]?.[name];
  return entry?.text ?? key;
};
const copy = { text: (k: string) => lookup(k), format: (k: string) => lookup(k) } as never;

const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000a1' as Hex;
const TOKEN = '0x00000000000000000000000000000000000000c1' as Hex;
const FROM = '0x00000000000000000000000000000000000000f1' as Hex;

const facts = (over: Partial<RecoverFacts> = {}): RecoverFacts => ({
  subject: { standard: 'erc20', asset: TOKEN, tokenId: 0n },
  block: 10n,
  vault: '0x00000000000000000000000000000000000000b1',
  untracked: 500n,
  bannedSource: null,
  frozen: null,
  protection: {
    enabled: false,
    locked: false,
    delaySeconds: 0,
    requireCosign: false,
    retired: false,
    controller: '0x0000000000000000000000000000000000000000',
  },
  eoaStyle: true,
  paused: false,
  screenSet: true,
  ackMatches: true,
  nonce: 0n,
  readAt: 1,
  ...over,
});

describe('the declaration and the signature', () => {
  it('signs the text the protocol binds, word for word', () => {
    const block = /ADOPTION_ACK_TEXT_HASH = keccak256\(\s*bytes\(([\s\S]*?)\)\s*\)/.exec(SOURCE)?.[1] ?? '';
    const text = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
    expect(text).toBe(ADOPTION_ACK_TEXT);
    expect(ADOPTION_ACK_HASH).toBe(keccak256(toBytes(text)));
  });

  it('builds the type the protocol hashes, field for field', () => {
    const typeString = /ADOPTION_TYPEHASH = keccak256\(\s*"([^"]+)"/.exec(SOURCE)?.[1];
    const ours = `AdoptionAcknowledgment(${ADOPTION_TYPES.AdoptionAcknowledgment.map((f) => `${f.type} ${f.name}`).join(',')})`;
    expect(ours).toBe(typeString);
    expect(SOURCE).toContain('keccak256("Vaipakam Vault Adoption")');
  });

  it('signs the digest adoptionDigest computes', () => {
    const d = { subject: { standard: 'erc1155' as const, asset: TOKEN, tokenId: 7n }, amount: 3n, source: FROM };
    const ours = hashTypedData({
      domain: adoptionDomain(84532, DIAMOND),
      types: ADOPTION_TYPES,
      primaryType: 'AdoptionAcknowledgment',
      message: adoptionMessage(ME, d, 4n, 1_900_000_000n),
    });
    const typeString = /ADOPTION_TYPEHASH = keccak256\(\s*"([^"]+)"/.exec(SOURCE)![1]!;
    const domainSep = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [
          keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
          keccak256(toBytes('Vaipakam Vault Adoption')),
          keccak256(toBytes('1')),
          84532n,
          DIAMOND,
        ],
      ),
    );
    const struct = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'address' },
          { type: 'uint8' },
          { type: 'uint256' },
          { type: 'address' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'bytes32' },
        ],
        [keccak256(toBytes(typeString)), ME, TOKEN, 2, 7n, FROM, 3n, 4n, 1_900_000_000n, ADOPTION_ACK_HASH],
      ),
    );
    expect(ours).toBe(keccak256(concat(['0x1901', domainSep, struct])));
  });

  it('adopts a whole ERC-721 and keys an ERC-20 under token 0', () => {
    expect(adoptionMessage(ME, { subject: { standard: 'erc721', asset: TOKEN, tokenId: 9n }, amount: 5n, source: FROM }, 0n, 1n).amount).toBe(1n);
    expect(adoptionMessage(ME, { subject: { standard: 'erc20', asset: TOKEN, tokenId: 9n }, amount: 5n, source: FROM }, 0n, 1n).tokenId).toBe(0n);
  });
});

describe('what stops adopting and disowning', () => {
  it('states the first stop, in the protocol’s order', () => {
    expect(adoptStops(facts(), copy)).toEqual([]);
    expect(adoptStops(facts({ vault: null }), copy)[0]).toContain('no vault');
    expect(adoptStops(facts({ protection: { ...facts().protection!, retired: true } }), copy)[0]).toContain('retired');
    expect(adoptStops(facts({ eoaStyle: false }), copy)[0]).toContain('contract account');
    expect(adoptStops(facts({ bannedSource: FROM }), copy)[0]).toContain('barred');
    expect(adoptStops(facts({ frozen: 'flagged' }), copy)[0]).toContain('flags this wallet');
    expect(adoptStops(facts({ screenSet: false }), copy)[0]).toContain('no sanctions screen set');
    expect(adoptStops(facts({ paused: true }), copy)[0]).toContain('paused');
    expect(adoptStops(facts({ ackMatches: false }), copy)[0]).toContain('different declaration');
    expect(adoptStops(facts({ untracked: 0n }), copy)[0]).toContain('Nothing of this');
    expect(adoptStops(facts({ untracked: null }), copy)[0]).toContain('could not be read');
  });

  it('leaves disowning open to a replaced wallet, a contract account, a barred vault and a pause', () => {
    const f = facts({ protection: { ...facts().protection!, retired: true }, eoaStyle: false, bannedSource: FROM, paused: true, screenSet: false });
    expect(disownStops(f, copy)).toEqual([]);
    expect(disownStops(facts({ untracked: 0n }), copy)).toHaveLength(1);
    expect(disownStops(facts({ vault: null }), copy)[0]).toContain('no vault');
  });

  it('refuses a source the screen flags or cannot answer for, and more than sits uncounted', () => {
    const review = (over: Partial<AdoptReview>): AdoptReview => ({
      identity: 'x',
      draft: { subject: facts().subject, amount: 100n, source: FROM },
      facts: facts(),
      sourceScreen: 'clean',
      readAt: 1,
      ...over,
    });
    const amount = (v: bigint) => v.toString();
    expect(adoptBlockers(review({}), copy, amount)).toEqual([]);
    expect(adoptBlockers(review({ sourceScreen: 'flagged' }), copy, amount)[0]).toContain('flags this source');
    expect(adoptBlockers(review({ sourceScreen: 'unavailable' }), copy, amount)[0]).toContain('cannot answer');
    expect(adoptBlockers(review({ sourceScreen: 'unset' }), copy, amount)[0]).toContain('no sanctions screen set');
    expect(adoptBlockers(review({ draft: { subject: facts().subject, amount: 501n, source: FROM } }), copy, amount)[0]).toContain('no more can be adopted');
  });
});

describe('the outcome, from the transaction’s record', () => {
  const abi = VaultDepositoryFacetABI as Abi;
  const log = (eventName: string, args: Record<string, unknown>, data: Hex): Log =>
    ({ address: DIAMOND, topics: encodeEventTopics({ abi, eventName, args } as never), data }) as unknown as Log;

  it('reads a credit, a bar and a disowning for this asset only', () => {
    const subject = { standard: 'erc20' as const, asset: TOKEN, tokenId: 0n };
    const adopted = log(
      'UntrackedAdopted',
      { account: ME, asset: TOKEN, declaredSource: FROM },
      encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [0, 0n, 250n, 0n]),
    );
    expect(adoptRecorded([adopted], DIAMOND, ME, subject)).toEqual({ kind: 'adopted', amount: 250n, source: FROM });
    expect(adoptRecorded([adopted], DIAMOND, FROM, subject)).toEqual({ kind: 'none' });
    const barred = log(
      'VaultBannedFromAdoption',
      { account: ME, asset: TOKEN, declaredSource: FROM },
      encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, 250n]),
    );
    expect(adoptRecorded([barred], DIAMOND, ME, subject)).toEqual({ kind: 'barred', source: FROM });
    const disowned = log(
      'UntrackedDisowned',
      { account: ME, asset: TOKEN },
      encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [0n, 250n, 12n]),
    );
    expect(disownRecorded([disowned], DIAMOND, ME, subject)).toBe(250n);
    expect(disownRecorded([disowned], DIAMOND, ME, { ...subject, asset: FROM })).toBeNull();
  });
});
