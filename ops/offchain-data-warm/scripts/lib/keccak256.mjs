/**
 * #3688 — Keccak-256 (the Ethereum hash, NOT NIST SHA3-256: the padding byte
 * is 0x01, not 0x06), for checking a collection-offer list copy against the
 * hash in its name.
 *
 * This package carries no dependencies (BackupSecurityDesign.md: the backup
 * tools stay small enough to read), and Node's crypto offers only SHA3-256,
 * whose padding differs, so the permutation is written out here. Lanes are
 * 64-bit words held as two 32-bit halves. The tests pin it to the standard
 * vectors and to the list hashes the indexer computes.
 */

const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000], [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000], [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];
// Rotation offsets, indexed by lane x + 5y.
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

/** Rotate the 64-bit lane (lo, hi) left by n. */
function rotl(lo, hi, n) {
  if (n === 0) return [lo, hi];
  if (n >= 32) {
    [lo, hi] = [hi, lo];
    n -= 32;
    if (n === 0) return [lo, hi];
  }
  return [((lo << n) | (hi >>> (32 - n))) >>> 0, ((hi << n) | (lo >>> (32 - n))) >>> 0];
}

function permute(lo, hi) {
  const cLo = new Uint32Array(5);
  const cHi = new Uint32Array(5);
  const bLo = new Uint32Array(25);
  const bHi = new Uint32Array(25);
  for (let round = 0; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) {
      cLo[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20];
      cHi[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const [rLo, rHi] = rotl(cLo[(x + 1) % 5], cHi[(x + 1) % 5], 1);
      const dLo = cLo[(x + 4) % 5] ^ rLo;
      const dHi = cHi[(x + 4) % 5] ^ rHi;
      for (let y = 0; y < 25; y += 5) {
        lo[x + y] ^= dLo;
        hi[x + y] ^= dHi;
      }
    }
    // ρ and π: B[y, 2x+3y] = rot(A[x, y], r[x, y])
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const [rLo, rHi] = rotl(lo[i], hi[i], ROT[i]);
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        bLo[j] = rLo;
        bHi[j] = rHi;
      }
    }
    // χ
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        lo[x + y] = bLo[x + y] ^ (~bLo[((x + 1) % 5) + y] & bLo[((x + 2) % 5) + y]);
        hi[x + y] = bHi[x + y] ^ (~bHi[((x + 1) % 5) + y] & bHi[((x + 2) % 5) + y]);
      }
    }
    // ι
    lo[0] ^= RC[round][0];
    hi[0] ^= RC[round][1];
  }
}

const RATE = 136; // bytes: 1088-bit rate for a 256-bit output

/** Keccak-256 of `bytes` (a Uint8Array or Buffer), as `0x`-prefixed lowercase hex. */
export function keccak256(bytes) {
  const lo = new Uint32Array(25);
  const hi = new Uint32Array(25);
  const padded = new Uint8Array(Math.floor(bytes.length / RATE) * RATE + RATE);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const view = new DataView(padded.buffer);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      lo[i] ^= view.getUint32(off + i * 8, true);
      hi[i] ^= view.getUint32(off + i * 8 + 4, true);
    }
    permute(lo, hi);
  }
  const out = new DataView(new ArrayBuffer(32));
  for (let i = 0; i < 4; i++) {
    out.setUint32(i * 8, lo[i], true);
    out.setUint32(i * 8 + 4, hi[i], true);
  }
  return `0x${Buffer.from(out.buffer).toString('hex')}`;
}
