/**
 * Chromium's system libraries, fetched into a private folder when the
 * build host does not have them (#2903).
 *
 * Why this exists: the production www deploy runs on Cloudflare Workers
 * Builds, whose Ubuntu 24.04 image carries a short list of apt packages
 * and none of the shared libraries Chromium links against (libnss3,
 * libatk, libasound and the X11 client libraries among them). Playwright
 * downloads the browser itself without trouble, but the browser cannot
 * start, so the prerender pass — which the spec requires on every deploy
 * — failed every build. The usual remedy, `playwright install
 * --with-deps`, needs root and a writable system apt, which a hosted
 * build image is not promised to give.
 *
 * What it does instead: asks the dynamic loader (`ldd`) which libraries
 * the browser cannot find, maps each one to the Ubuntu package that
 * ships it, downloads those packages with the host's own apt (signature
 * checked against the host's keyring, as any apt download is) into a
 * private apt state, unpacks them into a private root, and repeats until
 * nothing is missing. Prerender then launches Chromium with
 * LD_LIBRARY_PATH pointing at that root. No system file is written and
 * nothing needs root.
 *
 * It fails loudly, never quietly: a library with no known package, a host
 * without apt, or a library still missing after the fetch is an error
 * that names what is wrong, and prerender reports it with every other
 * attempt it made.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The Ubuntu 24.04 package that ships each shared library Playwright's
 * Chromium needs, measured with `ldd` and `dpkg -S` on Ubuntu 24.04
 * against the binary prerender launches — the full Chromium 149 build
 * (Playwright 1.61.1), whose dependency set contains the headless shell's —
 * plus the NSS libraries that only show up once libnss3 itself is found.
 * A library Chromium starts needing that is not listed here makes the
 * fetch fail and name it, so the table is extended deliberately rather
 * than guessed at; re-measure it whenever Playwright's Chromium revision
 * moves. glibc itself (libc, libm, libdl, libpthread, libresolv, the
 * loader) is absent on purpose: a host missing it has a different problem.
 */
export const SONAME_PACKAGES = Object.freeze({
  'libasound.so.2': 'libasound2t64',
  'libatk-1.0.so.0': 'libatk1.0-0t64',
  'libatk-bridge-2.0.so.0': 'libatk-bridge2.0-0t64',
  'libatspi.so.0': 'libatspi2.0-0t64',
  'libavahi-client.so.3': 'libavahi-client3',
  'libavahi-common.so.3': 'libavahi-common3',
  'libblkid.so.1': 'libblkid1',
  'libbrotlicommon.so.1': 'libbrotli1',
  'libbrotlidec.so.1': 'libbrotli1',
  'libbsd.so.0': 'libbsd0',
  'libbz2.so.1.0': 'libbz2-1.0',
  'libcairo.so.2': 'libcairo2',
  'libcap.so.2': 'libcap2',
  'libcom_err.so.2': 'libcom-err2',
  'libcups.so.2': 'libcups2t64',
  'libdatrie.so.1': 'libdatrie1',
  'libdbus-1.so.3': 'libdbus-1-3',
  'libdrm.so.2': 'libdrm2',
  'libexpat.so.1': 'libexpat1',
  'libffi.so.8': 'libffi8',
  'libfontconfig.so.1': 'libfontconfig1',
  'libfreetype.so.6': 'libfreetype6',
  'libfribidi.so.0': 'libfribidi0',
  'libgbm.so.1': 'libgbm1',
  'libgcc_s.so.1': 'libgcc-s1',
  'libgcrypt.so.20': 'libgcrypt20',
  'libgio-2.0.so.0': 'libglib2.0-0t64',
  'libglib-2.0.so.0': 'libglib2.0-0t64',
  'libgmodule-2.0.so.0': 'libglib2.0-0t64',
  'libgmp.so.10': 'libgmp10',
  'libgnutls.so.30': 'libgnutls30t64',
  'libgobject-2.0.so.0': 'libglib2.0-0t64',
  'libgpg-error.so.0': 'libgpg-error0',
  'libgraphite2.so.3': 'libgraphite2-3',
  'libgssapi_krb5.so.2': 'libgssapi-krb5-2',
  'libharfbuzz.so.0': 'libharfbuzz0b',
  'libhogweed.so.6': 'libhogweed6t64',
  'libidn2.so.0': 'libidn2-0',
  'libk5crypto.so.3': 'libk5crypto3',
  'libkeyutils.so.1': 'libkeyutils1',
  'libkrb5.so.3': 'libkrb5-3',
  'libkrb5support.so.0': 'libkrb5support0',
  'liblz4.so.1': 'liblz4-1',
  'liblzma.so.5': 'liblzma5',
  'libmd.so.0': 'libmd0',
  'libmount.so.1': 'libmount1',
  'libnettle.so.8': 'libnettle8t64',
  'libnspr4.so': 'libnspr4',
  'libnss3.so': 'libnss3',
  'libnssutil3.so': 'libnss3',
  'libp11-kit.so.0': 'libp11-kit0',
  'libpango-1.0.so.0': 'libpango-1.0-0',
  'libpcre2-8.so.0': 'libpcre2-8-0',
  'libpixman-1.so.0': 'libpixman-1-0',
  'libplc4.so': 'libnspr4',
  'libplds4.so': 'libnspr4',
  'libpng16.so.16': 'libpng16-16t64',
  'libselinux.so.1': 'libselinux1',
  'libsmime3.so': 'libnss3',
  'libssl3.so': 'libnss3',
  'libsystemd.so.0': 'libsystemd0',
  'libtasn1.so.6': 'libtasn1-6',
  'libthai.so.0': 'libthai0',
  'libudev.so.1': 'libudev1',
  'libunistring.so.5': 'libunistring5',
  'libX11.so.6': 'libx11-6',
  'libXau.so.6': 'libxau6',
  'libxcb-render.so.0': 'libxcb-render0',
  'libxcb-shm.so.0': 'libxcb-shm0',
  'libxcb.so.1': 'libxcb1',
  'libXcomposite.so.1': 'libxcomposite1',
  'libXdamage.so.1': 'libxdamage1',
  'libXdmcp.so.6': 'libxdmcp6',
  'libXext.so.6': 'libxext6',
  'libXfixes.so.3': 'libxfixes3',
  'libXi.so.6': 'libxi6',
  'libxkbcommon.so.0': 'libxkbcommon0',
  'libXrandr.so.2': 'libxrandr2',
  'libXrender.so.1': 'libxrender1',
  'libz.so.1': 'zlib1g',
  'libzstd.so.1': 'libzstd1',
});

/** Rounds of fetch-then-recheck: each round can only reveal the
 *  dependencies of libraries the previous round supplied. */
const MAX_ROUNDS = 4;

/** The libraries `ldd` output reports as missing, in order, deduplicated. */
export function parseLddMissing(output) {
  const missing = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\S+)\s+=>\s+not found\s*$/.exec(line);
    if (m && !missing.includes(m[1])) missing.push(m[1]);
  }
  return missing;
}

/**
 * The packages that ship `sonames`, deduplicated. Throws naming every
 * library the table does not cover, so an unknown dependency is a loud
 * failure rather than a fetch that silently leaves it missing.
 */
export function packagesFor(sonames) {
  const unknown = sonames.filter((s) => !Object.hasOwn(SONAME_PACKAGES, s));
  if (unknown.length > 0) {
    throw new Error(
      `no known Ubuntu package for ${unknown.join(', ')} ` +
        '(extend SONAME_PACKAGES in apps/www/scripts/chromiumSystemLibs.mjs)',
    );
  }
  return [...new Set(sonames.map((s) => SONAME_PACKAGES[s]))];
}

/** The multiarch library directories inside an unpacked root. */
function libDirs(root) {
  const triplet = process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
  return [join(root, 'usr', 'lib', triplet), join(root, 'lib', triplet)];
}

function joinPath(dirs, existing) {
  return [...dirs, ...(existing ? [existing] : [])].join(':');
}

/** Run a command, returning stdout; throws with its stderr on failure. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.error) throw new Error(`${cmd}: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${cmd} ${args[0] ?? ''} exited ${res.status}: ${detail}`);
  }
  return res.stdout;
}

/** The libraries `executable` cannot load, searching `dirs` first. */
function missingLibraries(executable, dirs) {
  const env = { ...process.env, LD_LIBRARY_PATH: joinPath(dirs, process.env.LD_LIBRARY_PATH) };
  // ldd exits non-zero when a library is missing on some glibc builds, so
  // read its output rather than its status.
  const res = spawnSync('ldd', [executable], { encoding: 'utf8', env });
  if (res.error) throw new Error(`ldd: ${res.error.message}`);
  return parseLddMissing(`${res.stdout}\n${res.stderr}`);
}

/**
 * Make sure every shared library `executable` links against can be found.
 *
 * Returns `null` when the host alone supplies every library (the
 * browser's failure to start is then not a library problem, and the caller
 * reports its own error). Otherwise returns the environment the browser
 * must be launched with, fetching and unpacking what is missing unless an
 * earlier run on this host already left it in the private root. Throws, naming the
 * cause, when the libraries cannot be supplied.
 *
 * @param {string} executable the browser binary Playwright launches
 * @param {{ dir?: string, log?: (msg: string) => void }} [opts]
 */
export function provideChromiumSystemLibs(executable, opts = {}) {
  const log = opts.log ?? ((msg) => console.warn(msg));
  if (process.platform !== 'linux') return null;
  if (!existsSync(executable)) throw new Error(`browser not installed at ${executable}`);

  const base =
    opts.dir ?? process.env.PRERENDER_LIBS_DIR ?? join(homedir(), '.cache', 'vaipakam-prerender-libs');
  const root = join(base, 'root');
  const debs = join(base, 'debs');
  const dirs = libDirs(root);

  // The host alone supplies everything: the browser's failure is not ours.
  if (missingLibraries(executable, []).length === 0) return null;
  const env = { LD_LIBRARY_PATH: joinPath(dirs, process.env.LD_LIBRARY_PATH) };
  // A previous run on this host left the libraries in the private root.
  let missing = missingLibraries(executable, dirs);
  if (missing.length === 0) {
    log(`[prerender] system libraries supplied from ${root} (already fetched)`);
    return env;
  }

  log(`[prerender] Chromium cannot load ${missing.length} system librar${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}`);
  for (const d of [join(base, 'lists', 'partial'), join(base, 'cache', 'archives', 'partial'), debs, root]) {
    mkdirSync(d, { recursive: true });
  }
  // A private apt state, so neither root nor a writable system apt is needed.
  const apt = [
    '-q',
    '-o', `Dir::State::Lists=${join(base, 'lists')}`,
    '-o', `Dir::Cache=${join(base, 'cache')}`,
    '-o', 'Debug::NoLocking=1',
  ];
  log('[prerender] reading the package index with the host apt (private state, no root)…');
  run('apt-get', [...apt, 'update']);

  const unpacked = new Set();
  for (let round = 1; round <= MAX_ROUNDS && missing.length > 0; round++) {
    const pkgs = packagesFor(missing);
    log(`[prerender] fetching ${pkgs.join(' ')}`);
    run('apt-get', [...apt, 'download', ...pkgs], { cwd: debs });
    for (const deb of readdirSync(debs).filter((f) => f.endsWith('.deb'))) {
      if (unpacked.has(deb)) continue;
      run('dpkg-deb', ['-x', join(debs, deb), root]);
      unpacked.add(deb);
    }
    missing = missingLibraries(executable, dirs);
  }
  if (missing.length > 0) {
    throw new Error(`still missing after fetching: ${missing.join(', ')}`);
  }
  log(`[prerender] system libraries supplied from ${root}`);
  return env;
}
