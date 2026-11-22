// node --test ops/node-capability/check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, watchedAddresses, checkNetwork, NETWORKS } from './check.mjs';

test('scrub removes the endpoint, its host and key-like runs', () => {
  const url = 'https://node.example.invalid/v2/abcdefghijklmnopqrstuvwxyz0123456789';
  const out = scrub(`failed at ${url} (host node.example.invalid) key abcdefghijklmnopqrstuvwxyz0123456789`, url);
  assert.ok(!out.includes('example'), out);
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'), out);
});

test('scrub keeps hex values and caps the length', () => {
  const h = `0x${'ab'.repeat(32)}`;
  assert.ok(scrub(`revert ${h}`).includes(h));
  assert.ok(scrub('x'.repeat(10) + ' y'.repeat(200)).length <= 120);
});

test('scrub removes any url even without the endpoint', () => {
  assert.equal(scrub('see https://a.b/c?d=e now'), 'see <url> now');
});

test('watched addresses are the entry contracts, not people, facets or implementations', () => {
  const a = (n) => `0x${String(n).repeat(40)}`;
  const got = watchedAddresses({
    diamond: a(1), admin: a(2), treasury: a(3), keeperAddress: a(4),
    facets: { x: a(5) }, vaultImpl: a(6), positionNFT: a(7), testnetMocks: { usdc: a(8) }, chainId: 1,
  });
  assert.deepEqual(got, [a(1), a(7), a(8)]);
});

test('the deploy .env name is read when the service name is absent', async () => {
  const net = NETWORKS.find((n) => n.slug === 'base-sepolia');
  const r = await checkNetwork(net, { BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:1' });
  assert.equal(r.nodeVariable, 'BASE_SEPOLIA_RPC_URL');
  assert.ok(!JSON.stringify(r).includes('127.0.0.1'));
});

test('a network with no node configured is reported, not skipped', async () => {
  const r = await checkNetwork(NETWORKS[0], {});
  assert.equal(r.status, 'no node configured');
  assert.equal(r.network, NETWORKS[0].slug);
});
