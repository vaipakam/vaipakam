// #2841 — every drive reads the chain through the driver's shape-checked
// client, and a PASS reached after a shape mismatch ends BLOCKED. The exit
// rule is a process `exit` listener, so it is driven in a child process:
// a PASS after a swallowed mismatch and an uncaught mismatch end at 2,
// while a FAIL or UNDETERMINED the drive chose stands with the reason.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = pathToFileURL(path.join(HERE, 'driver.mjs')).href;

const word = (n) => n.toString(16).padStart(64, '0');
/** A child that reads `bundle()` through `livePublicClient`, swallowing
 *  any error the way a drive's catch might, then runs `then`. */
function child(answer, then) {
  const code = `
    import { custom, parseAbi } from 'viem';
    import { livePublicClient } from ${JSON.stringify(DRIVER)};
    const pub = livePublicClient({ transport: custom({ async request({ method }) {
      if (method === 'eth_chainId') return '0x14a34';
      return ${JSON.stringify(answer)};
    } }) });
    const abi = parseAbi(['function bundle() view returns (uint256 a, uint256 b, bool c)']);
    let read = null;
    try { read = await pub.readContract({ address: '0x1111111111111111111111111111111111111111', abi, functionName: 'bundle' }); }
    catch (err) { console.log('swallowed', err.name); }
    ${then}
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.resolve(HERE, '../..'),
    encoding: 'utf8',
    timeout: 60_000,
  });
}
const RIGHT = `0x${word(7n)}${word(9n)}${word(1n)}`;
const WRONG = `0x${word(7n)}${word(1n)}${word(0n)}${word(1n)}`;

describe('a shape mismatch withdraws a PASS', () => {
  it('leaves the drive\'s own code alone when every answer had its shape', () => {
    const r = child(RIGHT, 'console.log(String(read)); process.exit(0);');
    expect(r.stdout).toContain('7,9,true');
    expect(r.status).toBe(0);
  });

  it('turns a PASS the drive reached after swallowing the mismatch into BLOCKED, naming it', () => {
    const r = child(WRONG, 'process.exit(0);');
    expect(r.stdout).toContain('swallowed LiveShapeMismatchError');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED: bundle answered 4 words, and this build's ABI describes 3 words/);
    expect(r.stderr).toMatch(/the PASS this drive reached rested on that answer and is withdrawn/);
  });

  it('turns a PASS at the natural end of the script into BLOCKED too', () => {
    const r = child(WRONG, '');
    expect(r.status).toBe(2);
  });

  it('keeps a FAIL, which can rest on evidence the mismatch does not touch, and adds the reason', () => {
    const r = child(WRONG, 'process.exit(1);');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/shape this build does not describe: bundle answered 4 words/);
  });

  it('keeps UNDETERMINED, which also says the drive wrote, and adds the reason', () => {
    const r = child(WRONG, 'process.exit(3);');
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/shape this build does not describe: bundle answered 4 words/);
  });

  it('turns an uncaught mismatch into BLOCKED, not the 1 Node exits with', () => {
    const r = child(WRONG, 'throw new (await import(' + JSON.stringify(DRIVER) + ")).LiveShapeMismatchError('again');");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED: bundle answered 4 words/);
  });

  it('keeps an uncaught throw of anything else as Node\'s FAIL, with the reason', () => {
    const r = child(WRONG, "throw new Error('drive gave up');");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/shape this build does not describe: bundle answered 4 words/);
  });
});

describe('every drive reads the chain through livePublicClient', () => {
  const sources = fs
    .readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .map((f) => [f, fs.readFileSync(path.join(HERE, f), 'utf8')]);

  it('constructs no other public client, except the page\'s own transport', () => {
    const found = sources.flatMap(([f, src]) =>
      src.split('\n').flatMap((line, i) => (line.includes('createPublicClient(') ? [`${f}:${i + 1}`] : [])),
    );
    // driver.mjs: the factory itself, and the injected wallet's dispatch,
    // which forwards the page's own requests and decodes nothing.
    expect(found.map((x) => x.split(':')[0])).toEqual(['driver.mjs', 'driver.mjs']);
    const driver = sources.find(([f]) => f === 'driver.mjs')[1];
    expect(driver).toContain('return shapeChecked(createPublicClient(options), loadShapeRule);');
    expect(driver).toMatch(/The PAGE's transport, not a drive's read[\s\S]{0,400}const pub = createPublicClient\(/);
  });

  it('makes no raw eth_call around the checked reads', () => {
    // A drive that wants the bytes uses `readRaw`, which checks them.
    const raw = sources.filter(([, src]) => /\bpub\.call\(/.test(src)).map(([f]) => f);
    expect(raw).toEqual([]);
  });

  it('calls no viem read action around the client', () => {
    const bypass = sources.filter(([, src]) => /from 'viem\/actions'/.test(src)).map(([f]) => f);
    expect(bypass).toEqual(['shapeCheckedClient.mjs']);
  });
});
