import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diamondFunctionNames, findViolations, namesUsed } from './check-diamond-abi-usage.mjs';

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

test('the guard knows the names the PR removed and kept', () => {
  const names = diamondFunctionNames();
  assert.equal(names.has('ownerOf'), false);
  assert.equal(names.has('positionRoute'), true);
});
