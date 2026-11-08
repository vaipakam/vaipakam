import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations, generatedAbis, namesUsed } from './check-diamond-abi-usage.mjs';

test('the tree sends only functions the generated Diamond ABI carries', () => {
  const bad = findViolations();
  assert.deepEqual(
    bad.map((b) => `${b.file}:${b.line} ${b.name}`),
    [],
    'a consumer names a function the Diamond no longer has (#3318 r2)',
  );
});

test('an abi object with a literal functionName is read', () => {
  const src = `client.readContract({\n  address: d,\n  abi: DIAMOND_ABI_VIEM,\n  functionName: "ownerOf",\n  args: [1n],\n})`;
  assert.deepEqual(namesUsed(src).map((u) => u.name), ['ownerOf']);
});

test("useDiamondWrite's write is read unless it targets another contract", () => {
  const src = `const { write } = useDiamondWrite();\nawait write('releasePositionTransfer', [id]);\nawait write('lock', [], { target: core });`;
  assert.deepEqual(namesUsed(src).map((u) => u.name), ['releasePositionTransfer']);
});

test("a driver helper bound to the Diamond ABI is followed to its calls", () => {
  const src = `const read = (functionName, args = []) => pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName, args });\nconst h = await read('ownerOf', [1n]);\nconst l = await read('getLoanDetails', [1n]);`;
  assert.deepEqual(namesUsed(src).map((u) => u.name), ['ownerOf', 'getLoanDetails']);
});

test('a per-facet ABI alias passed to a read helper is checked against that facet', () => {
  const src = `const NFT = VaipakamNFTFacetABI as Abi;\nconst a = read<Hex>(NFT, 'ownerOf', [id]);\nconst b = read<Hex>(NFT, 'positionRoute', [id]);`;
  assert.deepEqual(namesUsed(src).map((u) => [u.name, u.abi]), [['ownerOf', 'VaipakamNFTFacetABI'], ['positionRoute', 'VaipakamNFTFacetABI']]);
});

test('the anvil harness Diamond write is checked', () => {
  const src = `const sc = scenario();\nawait sc.diamondWrite('lender', 'transferFrom', [a, b, 1n]);`;
  assert.deepEqual(namesUsed(src).map((u) => u.name), ['transferFrom']);
});

test('the guard knows the names the PR removed and kept', () => {
  const abis = generatedAbis();
  assert.equal(abis.get('DIAMOND_ABI_VIEM').has('ownerOf'), false);
  assert.equal(abis.get('VaipakamNFTFacetABI').has('positionLock'), false);
  assert.equal(abis.get('VaipakamNFTFacetABI').has('positionRoute'), true);
});
