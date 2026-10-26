import { describe, expect, it } from 'vitest';
import { readBodyBytes, readBodyText, readFormBody, readJsonBody } from './requestBody';

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('https://worker.example/', { method: 'POST', body, headers });

/** A body with no Content-Length, so the cap must trip on the stream. */
function streamed(text: string, onPull?: () => void): Request {
  const bytes = new TextEncoder().encode(text);
  let sent = 0;
  return new Request('https://worker.example/', {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        onPull?.();
        if (sent >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(sent, sent + 1024));
        sent += 1024;
      },
    }),
    // @ts-expect-error — undici needs `duplex` for a stream body
    duplex: 'half',
  });
}

describe('readBodyBytes', () => {
  it('reads a body within the cap', async () => {
    const read = await readBodyBytes(post('hello'), 5);
    expect(read.ok && new TextDecoder().decode(read.bytes)).toBe('hello');
  });

  it('refuses a declared length over the cap without reading the body', async () => {
    const req = post('tiny', { 'content-length': '1000' });
    expect(await readBodyBytes(req, 999)).toEqual({ ok: false, status: 413, error: 'body-too-large' });
    expect(req.bodyUsed).toBe(false);
  });

  it('stops a stream at the first chunk past the cap, whatever the header says', async () => {
    let pulls = 0;
    const read = await readBodyBytes(streamed('x'.repeat(64 * 1024), () => pulls++), 4 * 1024);
    expect(read).toEqual({ ok: false, status: 413, error: 'body-too-large' });
    // Five 1 KiB chunks cross a 4 KiB cap; the other 59 are never pulled.
    expect(pulls).toBeLessThan(8);
  });

  it('reads an empty body', async () => {
    const read = await readBodyBytes(new Request('https://worker.example/'), 10);
    expect(read.ok && read.bytes.byteLength).toBe(0);
  });
});

describe('readJsonBody and readBodyText', () => {
  it('parses JSON within the cap', async () => {
    expect(await readJsonBody(post('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('names a body that is not JSON', async () => {
    expect(await readJsonBody(post('{nope'), 100)).toEqual({ ok: false, status: 400, error: 'invalid-json' });
  });

  it('refuses an oversized body before parsing it', async () => {
    expect(await readJsonBody(streamed(JSON.stringify({ a: 'x'.repeat(5000) })), 1000)).toEqual({
      ok: false,
      status: 413,
      error: 'body-too-large',
    });
  });

  it('decodes text as UTF-8', async () => {
    expect(await readBodyText(post('héllo'), 100)).toEqual({ ok: true, text: 'héllo' });
  });
});

describe('readFormBody', () => {
  it('parses a multipart body within the cap', async () => {
    const fd = new FormData();
    fd.set('payload', '{"x":1}');
    const req = new Request('https://worker.example/', { method: 'POST', body: fd });
    const read = await readFormBody(req, 10_000);
    expect(read.ok && read.form?.get('payload')).toBe('{"x":1}');
  });

  it('answers null for a body that does not parse as the form it claims', async () => {
    const read = await readFormBody(post('not a form', { 'content-type': 'multipart/form-data; boundary=zzz' }), 1000);
    expect(read).toEqual({ ok: true, form: null });
  });

  it('refuses an oversized form', async () => {
    const fd = new FormData();
    fd.set('document', new Blob([new Uint8Array(5000)]));
    const req = new Request('https://worker.example/', { method: 'POST', body: fd });
    expect(await readFormBody(req, 1000)).toEqual({ ok: false, status: 413, error: 'body-too-large' });
  });
});
