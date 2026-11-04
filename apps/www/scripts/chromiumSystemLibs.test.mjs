/**
 * The pure halves of chromiumSystemLibs.mjs (#2903): reading `ldd`'s
 * report and mapping a library to its package. The fetch itself needs apt
 * and a host missing the libraries, so it is proven by the deploy, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SONAME_PACKAGES, packagesFor, parseLddMissing } from './chromiumSystemLibs.mjs';

const LDD = `	linux-vdso.so.1 (0x00007ffd5c9f2000)
	libdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x00007f1b2c000000)
	libnspr4.so => not found
	libnss3.so => not found
	libatk-1.0.so.0 => not found
	libnss3.so => not found
	/lib64/ld-linux-x86-64.so.2 (0x00007f1b2c600000)`;

test('reads every missing library once, in order', () => {
  assert.deepEqual(parseLddMissing(LDD), ['libnspr4.so', 'libnss3.so', 'libatk-1.0.so.0']);
});

test('a fully resolved report has nothing missing', () => {
  assert.deepEqual(parseLddMissing('\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x1)\n'), []);
});

test('maps libraries to packages, one fetch per package', () => {
  assert.deepEqual(packagesFor(['libnss3.so', 'libnssutil3.so', 'libnspr4.so']), ['libnss3', 'libnspr4']);
});

test('covers every library the launched browser needs, as measured', () => {
  for (const so of ['libcups.so.2', 'libpango-1.0.so.0', 'libcairo.so.2', 'libnss3.so', 'libsmime3.so']) {
    assert.ok(Object.hasOwn(SONAME_PACKAGES, so), so);
  }
});

test('an unknown library is an error that names it', () => {
  assert.throws(() => packagesFor(['libnss3.so', 'libmystery.so.9']), /libmystery\.so\.9/);
});

test('glibc is deliberately not fetched', () => {
  for (const so of ['libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'libresolv.so.2']) {
    assert.equal(Object.hasOwn(SONAME_PACKAGES, so), false, so);
  }
});
