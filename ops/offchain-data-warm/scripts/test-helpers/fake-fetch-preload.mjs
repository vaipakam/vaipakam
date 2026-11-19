/**
 * Runs a command-line B2 script against the in-memory B2 (#3032).
 *
 * Loaded with `node --import` by `b2-scripts-cli.test.mjs`. It builds a fake
 * B2 from the JSON in `FAKE_B2_WORLD` and puts its `fetch` in place of the
 * global one, so a script that signs in and calls through
 * `lib/b2-native.mjs` reaches it and nothing else. Not a test file itself.
 */

import { fakeB2 } from './fake-b2.mjs';

const world = JSON.parse(process.env.FAKE_B2_WORLD ?? '{}');
const b2 = fakeB2({ now: Date.now() });
for (const b of world.buckets ?? []) b2.bucket(b.name, b);
for (const k of world.keys ?? []) b2.key(k.id, k);
for (const f of world.files ?? []) b2.put(f.bucket, f.name, f.body ?? 'x');
globalThis.fetch = b2.fetch;
